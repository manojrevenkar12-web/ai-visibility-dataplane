// A lease lock with a fencing token (Kleppmann, "How to do distributed locking"). The lock alone
// cannot stop a paused holder from acting after its lease expired; the fence can: every holder gets
// a strictly larger number, and the resource (Postgres here) refuses writes with an older one.
import type { SQL } from "bun";
import type Redis from "ioredis";

const ACQUIRE = `
-- KEYS: lock, counter ; ARGV: owner, ttl_ms
local cur = redis.call('GET', KEYS[1])
if cur and cur ~= ARGV[1] then return 0 end
if cur == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]); return tonumber(redis.call('GET', KEYS[2])) end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return redis.call('INCR', KEYS[2])`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export class FencedLock {
  constructor(
    private readonly r: Redis,
    readonly name: string,
    readonly owner: string,
    private readonly ttlMs: number,
  ) {}

  /** The fence if this owner holds (or now acquired/renewed) the lock, else null. */
  async acquire(): Promise<number | null> {
    const f = Number(await this.r.eval(ACQUIRE, 2, `lock:{${this.name}}`, `lock:{${this.name}}:fence`, this.owner, this.ttlMs));
    return f > 0 ? f : null;
  }

  async release(): Promise<void> {
    await this.r.eval(RELEASE, 1, `lock:{${this.name}}`, this.owner);
  }
}

/** Record the fence in Postgres; false if a newer holder has already written. Call inside the transaction that does the guarded work. */
export async function checkFence(tx: SQL, name: string, fence: number): Promise<boolean> {
  const rows = await tx`
    INSERT INTO leader_fence(name, fence) VALUES (${name}, ${fence})
    ON CONFLICT (name) DO UPDATE SET fence = EXCLUDED.fence WHERE leader_fence.fence <= EXCLUDED.fence
    RETURNING fence`;
  return rows.length === 1;
}
