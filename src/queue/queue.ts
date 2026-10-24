// A lease-based work queue on Redis.
//
// ready   ZSET  job id -> time it may run (ms)          delayed retries live here too
// leased  ZSET  job id -> lease expiry (ms)
// job:<id> HASH payload, attempts, fence
// dlq     LIST  dead-lettered job ids (the run row in Postgres keeps the reason)
//
// Every lease gets a fence from a global counter. Ack, retry and heartbeat only succeed while the
// job still carries the caller's fence, so a worker that stalled past its lease (GC pause, network
// partition) can no longer complete or reschedule work that was handed to someone else. Enqueue is
// idempotent on the job id. All transitions are single Lua scripts, so there is no window where a
// job is in neither set.
import type Redis from "ioredis";

const ENQUEUE = `
-- KEYS: ready, job ; ARGV: id, payload, at
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('HSET', KEYS[2], 'payload', ARGV[2], 'attempts', 0, 'fence', 0)
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
return 1`;

const LEASE = `
-- KEYS: ready, leased, fence_counter ; ARGV: now, lease_ms, n, prefix
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[3]))
local out = {}
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[1], id)
  local jk = ARGV[4] .. id
  -- an id whose job hash is gone (Redis lost it) is skipped, not resurrected empty: the
  -- scheduler's reconciler re-queues the run from Postgres
  if redis.call('HEXISTS', jk, 'payload') == 1 then
  local fence = redis.call('INCR', KEYS[3])
  redis.call('HSET', jk, 'fence', fence)
  local attempts = redis.call('HINCRBY', jk, 'attempts', 1)
  redis.call('ZADD', KEYS[2], tonumber(ARGV[1]) + tonumber(ARGV[2]), id)
  table.insert(out, id)
  table.insert(out, redis.call('HGET', jk, 'payload'))
  table.insert(out, attempts)
  table.insert(out, fence)
  end
end
return out`;

const ACK = `
-- KEYS: leased, job ; ARGV: id, fence
if redis.call('HGET', KEYS[2], 'fence') ~= ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
return 1`;

const RETRY = `
-- KEYS: leased, ready, job ; ARGV: id, fence, at, count_attempt
if redis.call('HGET', KEYS[3], 'fence') ~= ARGV[2] then return 0 end
if ARGV[4] == '0' then redis.call('HINCRBY', KEYS[3], 'attempts', -1) end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1`;

const DEAD = `
-- KEYS: leased, dlq, job ; ARGV: id, fence
if redis.call('HGET', KEYS[3], 'fence') ~= ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('RPUSH', KEYS[2], ARGV[1])
return 1`;

const HEARTBEAT = `
-- KEYS: leased, job ; ARGV: id, fence, until
if redis.call('HGET', KEYS[2], 'fence') ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[1], 'XX', ARGV[3], ARGV[1])
return 1`;

const REAP = `
-- KEYS: leased, ready ; ARGV: now, n
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZADD', KEYS[2], ARGV[1], id)
end
return #ids`;

export interface Lease<T> {
  id: string;
  payload: T;
  attempt: number;
  fence: number;
}

export class Queue<T> {
  readonly k: { ready: string; leased: string; dlq: string; fence: string; job: (id: string) => string; jobPrefix: string };

  constructor(
    private readonly r: Redis,
    readonly name: string,
    private readonly leaseMs: number,
  ) {
    const p = `q:{${name}}`; // hash tag: all keys of a queue live in one Redis Cluster slot
    this.k = {
      ready: `${p}:ready`,
      leased: `${p}:leased`,
      dlq: `${p}:dlq`,
      fence: `${p}:fence`,
      jobPrefix: `${p}:job:`,
      job: (id) => `${p}:job:${id}`,
    };
  }

  /** Returns false if a job with this id is already queued or running. */
  async enqueue(id: string, payload: T, at = Date.now()): Promise<boolean> {
    return (await this.r.eval(ENQUEUE, 2, this.k.ready, this.k.job(id), id, JSON.stringify(payload), at)) === 1;
  }

  async lease(n: number, now = Date.now()): Promise<Lease<T>[]> {
    const raw = (await this.r.eval(LEASE, 3, this.k.ready, this.k.leased, this.k.fence, now, this.leaseMs, n, this.k.jobPrefix)) as (
      | string
      | number
    )[];
    const out: Lease<T>[] = [];
    for (let i = 0; i < raw.length; i += 4) {
      out.push({
        id: String(raw[i]),
        payload: JSON.parse(String(raw[i + 1])) as T,
        attempt: Number(raw[i + 2]),
        fence: Number(raw[i + 3]),
      });
    }
    return out;
  }

  /** False means the lease was lost: another worker owns this job now; drop the result. */
  async ack(l: Lease<T>): Promise<boolean> {
    return (await this.r.eval(ACK, 2, this.k.leased, this.k.job(l.id), l.id, l.fence)) === 1;
  }

  /** Put the job back to run at `at`. `countAttempt: false` for deferrals that were not a try (circuit open, rate limit). */
  async retry(l: Lease<T>, at: number, countAttempt = true): Promise<boolean> {
    return (await this.r.eval(RETRY, 3, this.k.leased, this.k.ready, this.k.job(l.id), l.id, l.fence, at, countAttempt ? 1 : 0)) === 1;
  }

  async dead(l: Lease<T>): Promise<boolean> {
    return (await this.r.eval(DEAD, 3, this.k.leased, this.k.dlq, this.k.job(l.id), l.id, l.fence)) === 1;
  }

  async heartbeat(l: Lease<T>, now = Date.now()): Promise<boolean> {
    return (await this.r.eval(HEARTBEAT, 2, this.k.leased, this.k.job(l.id), l.id, l.fence, now + this.leaseMs)) === 1;
  }

  /** Hand expired leases back to the ready set. Returns how many. */
  async reap(now = Date.now(), n = 500): Promise<number> {
    return Number(await this.r.eval(REAP, 2, this.k.leased, this.k.ready, now, n));
  }

  async depth(): Promise<{ ready: number; leased: number; dead: number }> {
    const [ready, leased, dead] = await Promise.all([this.r.zcard(this.k.ready), this.r.zcard(this.k.leased), this.r.llen(this.k.dlq)]);
    return { ready, leased, dead };
  }

  async purge(): Promise<void> {
    const keys = await this.r.keys(`q:{${this.name}}*`);
    if (keys.length) await this.r.del(...keys);
  }
}
