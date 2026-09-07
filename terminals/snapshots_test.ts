import { assertEquals, assertRejects } from "@std/assert";
import { SnapshotBudget } from "./snapshots.ts";

Deno.test("recovery allocations stay reserved through consumption and cancellation", async () => {
  const budget = new SnapshotBudget(1, 1);
  const first = new AbortController();
  const release = await budget.acquire(first.signal);
  let admitted = false;
  const next = budget.acquire(new AbortController().signal).then((release) => {
    admitted = true;
    return release;
  });
  await assertRejects(
    () => budget.acquire(new AbortController().signal),
    Error,
    "queue is full",
  );
  const stream = budget.stream(
    new TextEncoder().encode("screen".repeat(100_000)),
    first.signal,
    release,
  );
  await Promise.resolve();
  assertEquals(admitted, false);
  first.abort();
  const nextRelease = await next;
  assertEquals(admitted, true);
  await assertRejects(() => new Response(stream).arrayBuffer(), DOMException);
  nextRelease();
  const finalRelease = await budget.acquire(new AbortController().signal);
  finalRelease();
});

Deno.test("aborting a queued recovery does not consume the next allocation", async () => {
  const budget = new SnapshotBudget(1, 1);
  const release = await budget.acquire(new AbortController().signal);
  const abort = new AbortController();
  const waiting = budget.acquire(abort.signal);
  const rejected = assertRejects(() => waiting, DOMException);
  abort.abort();
  await rejected;
  release();
  const nextRelease = await budget.acquire(new AbortController().signal);
  const response = new Response(
    budget.stream(
      new TextEncoder().encode("snapshot"),
      new AbortController().signal,
      nextRelease,
    ).pipeThrough(new DecompressionStream("gzip")),
  );
  assertEquals(await response.text(), "snapshot");
  const finalRelease = await budget.acquire(new AbortController().signal);
  finalRelease();
});
