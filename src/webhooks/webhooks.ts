// Webhooks: at-least-once delivery of the events written to the outbox with each result.
//
// Fan-out turns each new event into one delivery row per subscribed endpoint (idempotent on
// endpoint + event). The deliverer claims due deliveries with SKIP LOCKED (so several replicas can
// run), signs each request the Standard Webhooks way (webhook-id, webhook-timestamp,
// webhook-signature = HMAC-SHA256 over "id.timestamp.body"), and retries with jittered backoff.
// Receivers deduplicate on webhook-id; an endpoint that keeps failing is disabled with a reason
// instead of being retried forever.
import type { SQL } from "bun";
import { settings } from "../infra/config";
import { log } from "../infra/log";
import { m } from "../infra/metrics";
import { backoffMs } from "../queue/backoff";

export function sign(secret: string, id: string, timestamp: number, body: string): string {
  return `v1,${new Bun.CryptoHasher("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export function verify(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
  header: string,
  now = Date.now(),
  toleranceS = 300,
): boolean {
  if (Math.abs(now / 1000 - timestamp) > toleranceS) return false;
  const expected = sign(secret, id, timestamp, body);
  return header.split(" ").some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

export class WebhookDeliverer {
  private running = false;

  constructor(
    private readonly sql: SQL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fanOut(limit = 500): Promise<number> {
    return this.sql.begin(async (tx) => {
      const events =
        await tx`SELECT id, event_id, project_id, type FROM event_outbox WHERE fanned_out_at IS NULL ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
      if (!events.length) return 0;
      for (const e of events) {
        await tx`
          INSERT INTO webhook_delivery(endpoint_id, event_id)
          SELECT id, ${e.event_id} FROM webhook_endpoint
          WHERE project_id = ${e.project_id} AND active AND ${e.type} = ANY(event_types)
          ON CONFLICT (endpoint_id, event_id) DO NOTHING`;
      }
      await tx`UPDATE event_outbox SET fanned_out_at = now() WHERE id IN ${tx(events.map((e: { id: number }) => e.id))}`;
      return events.length;
    });
  }

  async deliverOnce(limit = 50): Promise<number> {
    const W = settings().limits.webhooks;
    // claim: push next_attempt_at out by the request timeout so no other replica takes them meanwhile
    const due = await this.sql.begin(async (tx) => {
      const rows = await tx`
        SELECT d.id, d.event_id, d.attempts, e.url, e.secret, e.id AS endpoint_id, o.type, o.payload, o.created_at
        FROM webhook_delivery d
        JOIN webhook_endpoint e ON e.id = d.endpoint_id
        JOIN event_outbox o ON o.event_id = d.event_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND e.active
        ORDER BY d.next_attempt_at LIMIT ${limit} FOR UPDATE OF d SKIP LOCKED`;
      if (rows.length) {
        await tx`UPDATE webhook_delivery SET next_attempt_at = now() + (${W.timeout_ms * 3} || ' milliseconds')::interval WHERE id IN ${tx(rows.map((r: { id: number }) => r.id))}`;
      }
      return rows;
    });
    await Promise.all(due.map((d: Record<string, unknown>) => this.send(d)));
    return due.length;
  }

  private async send(d: Record<string, unknown>) {
    const W = settings().limits.webhooks;
    const body = JSON.stringify({ type: d.type, created_at: new Date(d.created_at as string).toISOString(), data: d.payload });
    const ts = Math.floor(Date.now() / 1000);
    const id = d.event_id as string;
    let status: number | null = null;
    let error: string | null = null;
    try {
      const r = await this.fetchImpl(d.url as string, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": String(ts),
          "webhook-signature": sign(d.secret as string, id, ts, body),
        },
        body,
        signal: AbortSignal.timeout(W.timeout_ms),
      });
      status = r.status;
      await r.body?.cancel();
    } catch (e) {
      error = (e as Error).message;
    }
    const attempts = (d.attempts as number) + 1;
    if (status !== null && status >= 200 && status < 300) {
      m.webhookDeliveries.inc({ outcome: "delivered" });
      await this
        .sql`UPDATE webhook_delivery SET status = 'delivered', attempts = ${attempts}, last_status = ${status}, delivered_at = now() WHERE id = ${d.id}`;
      await this.sql`UPDATE webhook_endpoint SET consecutive_failures = 0 WHERE id = ${d.endpoint_id}`;
      return;
    }
    m.webhookDeliveries.inc({ outcome: status ? `http_${Math.floor(status / 100)}xx` : "error" });
    const final = attempts >= W.max_attempts || (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429);
    const next = new Date(Date.now() + backoffMs(attempts, W.base_ms, W.cap_ms) + W.base_ms);
    await this.sql`
      UPDATE webhook_delivery SET status = ${final ? "failed" : "pending"}, attempts = ${attempts}, last_status = ${status}, last_error = ${error}, next_attempt_at = ${next}
      WHERE id = ${d.id}`;
    const [ep] = await this
      .sql`UPDATE webhook_endpoint SET consecutive_failures = consecutive_failures + 1 WHERE id = ${d.endpoint_id} RETURNING consecutive_failures`;
    if (ep && ep.consecutive_failures >= W.disable_after_consecutive_failures) {
      await this
        .sql`UPDATE webhook_endpoint SET active = false, disabled_reason = ${`${ep.consecutive_failures} consecutive failures, last: ${status ?? error}`} WHERE id = ${d.endpoint_id} AND active`;
      log.warn("webhook endpoint disabled", { endpoint_id: d.endpoint_id });
    }
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        const a = await this.fanOut();
        const b = await this.deliverOnce();
        if (!a && !b) await Bun.sleep(100);
      } catch (e) {
        log.warn("webhook loop failed", { err: String(e) });
        await Bun.sleep(200);
      }
    }
  }

  stop() {
    this.running = false;
  }
}
