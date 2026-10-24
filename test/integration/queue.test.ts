import { beforeEach, describe, expect, test } from "bun:test";
import { Queue } from "../../src/queue/queue";
import { r } from "../helpers";

const q = new Queue<{ n: number }>(r, "t", 200);
beforeEach(async () => {
  await q.purge();
});

describe("lease queue", () => {
  test("enqueue is idempotent on the job id", async () => {
    expect(await q.enqueue("a", { n: 1 })).toBe(true);
    expect(await q.enqueue("a", { n: 2 })).toBe(false);
    const [l] = await q.lease(10);
    expect(l).toMatchObject({ id: "a", payload: { n: 1 }, attempt: 1 });
    expect(await q.lease(10)).toEqual([]);
  });

  test("delayed jobs are not leased early", async () => {
    await q.enqueue("later", { n: 1 }, Date.now() + 10_000);
    expect(await q.lease(10)).toEqual([]);
    expect((await q.depth()).ready).toBe(1);
  });

  test("an expired lease is handed to another worker, and the old holder can no longer ack", async () => {
    await q.enqueue("a", { n: 1 });
    const [first] = await q.lease(1);
    await Bun.sleep(250);
    expect(await q.reap()).toBe(1);
    const [second] = await q.lease(1);
    expect(second!.attempt).toBe(2);
    expect(second!.fence).toBeGreaterThan(first!.fence);
    expect(await q.ack(first!)).toBe(false); // fenced out
    expect(await q.retry(first!, Date.now())).toBe(false);
    expect(await q.ack(second!)).toBe(true);
    expect(await q.depth()).toEqual({ ready: 0, leased: 0, dead: 0 });
  });

  test("heartbeats keep a lease; deferrals do not count as attempts", async () => {
    await q.enqueue("a", { n: 1 });
    const [l] = await q.lease(1);
    await Bun.sleep(120);
    expect(await q.heartbeat(l!)).toBe(true);
    await Bun.sleep(120);
    expect(await q.reap()).toBe(0);
    expect(await q.retry(l!, Date.now(), false)).toBe(true);
    const [again] = await q.lease(1);
    expect(again!.attempt).toBe(1);
    expect(await q.retry(again!, Date.now(), true)).toBe(true);
    const [third] = await q.lease(1);
    expect(third!.attempt).toBe(2);
    expect(await q.dead(third!)).toBe(true);
    expect((await q.depth()).dead).toBe(1);
  });
});

test("ids whose job was lost are skipped, not leased empty", async () => {
  await q.enqueue("a", { n: 1 });
  await q.enqueue("b", { n: 2 });
  const [l] = await q.lease(1);
  await r.del(q.k.job("a"), q.k.job("b")); // Redis lost the job hashes but kept the sorted sets
  await Bun.sleep(250);
  await q.reap();
  expect(await q.lease(10)).toEqual([]);
  expect(await r.exists(q.k.job(l!.id))).toBe(0);
});
