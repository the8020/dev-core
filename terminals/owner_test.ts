import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { TerminalEngine } from "./engine.ts";
import { TerminalBusyError, TerminalOwner } from "./owner.ts";
import { outputSequence } from "./protocol.ts";
import {
  captureTerminal,
  installTerminalView,
  restoreTerminal,
} from "./state.ts";
import { snapshotJSON, TestSocket, TestTerminals } from "./test_support.ts";

const signal = new AbortController().signal;

Deno.test("snapshot continuation preserves detached queries and split UTF-8 without replay", async () => {
  const native = new TestTerminals();
  const owner = new TerminalOwner(native.native, native.api);
  const running = owner.run();
  const browser = new TerminalEngine(native.native.terminal.size);
  installTerminalView(browser.terminal);
  try {
    await native.output("hello\u001b[6n");
    assertEquals(native.replies.map((data) => new TextDecoder().decode(data)), [
      "\u001b[1;6R",
    ]);
    await native.output(new Uint8Array([0xf0, 0x9f]));
    const socket = new TestSocket();
    const view = await owner.attach(socket, "browser-one", false);
    const response = await owner.snapshot(view.id, signal);
    const sequence = Number(response.headers.get("x-terminal-sequence"));
    // Output arrives before the snapshot body has been consumed.
    await native.output(new Uint8Array([0x98, 0x80, 0x21]));
    assertEquals(socket.sent.length, 0);
    restoreTerminal(browser.terminal, await snapshotJSON(response));
    view.ready(sequence);
    const frames = socket.sent.filter((data) => data instanceof Uint8Array);
    assertEquals(frames.length, 1);
    assertEquals(outputSequence(frames[0]!), sequence + 1);
    await browser.apply({
      sequence: sequence + 1,
      data: frames[0]!.subarray(8),
    });
    view.acknowledge(sequence + 1);
    assertEquals(
      captureTerminal(browser.terminal),
      await owner.engine.capture(),
    );
    assertEquals(native.replies.length, 1);
    await owner.detach(view);
    assertEquals(native.closed, []);
    await native.output(" after navigation");
    assertEquals(native.created, 0);
    assert(
      owner.engine.terminal.buffer.active.getLine(0)?.translateToString(true)
        .includes("after navigation"),
    );
  } finally {
    await owner.close();
    await running;
    await browser.close();
  }
  assertEquals(native.closed, [native.native.terminal.id]);
});

Deno.test("one controller survives reload and explicit control transfer without closing the PTY", async () => {
  const native = new TestTerminals();
  const owner = new TerminalOwner(native.native, native.api);
  const running = owner.run();
  try {
    const first = await owner.attach(new TestSocket(), "one", false);
    await assertRejects(
      () => owner.attach(new TestSocket(), "two", false),
      TerminalBusyError,
    );
    const reload = await owner.attach(new TestSocket(), "one", false);
    assert(first.closed);
    const transfer = await owner.attach(new TestSocket(), "two", true);
    assert(reload.closed);
    assertEquals(native.closed, []);
    assert(native.detached.includes(first.attachment.attachmentId));
    assert(native.detached.includes(reload.attachment.attachmentId));
    await owner.detach(transfer);
  } finally {
    await owner.close();
    await running;
  }
});

Deno.test("browser send failures leave canonical output and detached query responses running", async () => {
  const native = new TestTerminals();
  const owner = new TerminalOwner(native.native, native.api);
  const running = owner.run();
  try {
    const socket = new TestSocket();
    const view = await owner.attach(socket, "one", false);
    const response = await owner.snapshot(view.id, signal);
    await snapshotJSON(response);
    view.ready(Number(response.headers.get("x-terminal-sequence")));
    socket.failSend = true;
    await native.output("visible after a broken transport");
    assert(view.closed);
    await native.output("\u001b[6n");
    assertEquals(native.replies.length, 1);
    assertEquals(native.closed, []);
    const fresh = await owner.attach(new TestSocket(), "fresh", false);
    const recovery = await owner.snapshot(fresh.id, signal);
    await snapshotJSON(recovery);
    assertEquals(Number(recovery.headers.get("x-terminal-sequence")), 2);
  } finally {
    await owner.close();
    await running;
  }
});

Deno.test("unacknowledged output disconnects a slow view while the owner keeps draining", async () => {
  const native = new TestTerminals();
  const owner = new TerminalOwner(native.native, native.api);
  const running = owner.run();
  try {
    const socket = new TestSocket();
    const view = await owner.attach(socket, "slow", false);
    const response = await owner.snapshot(view.id, signal);
    await snapshotJSON(response);
    view.ready(Number(response.headers.get("x-terminal-sequence")));
    const data = new TextEncoder().encode("detached output\r\n".repeat(1024));
    for (let i = 0; i < 80; i++) await native.output(data);
    assertEquals(socket.closed?.code, 1009);
    assertEquals(native.closed, []);
    await native.output("still running\u001b[6n");
    assertEquals(native.replies.length, 1);
  } finally {
    await owner.close();
    await running;
  }
});

Deno.test("input acknowledgement waits for native consumption and accepts one frame at a time", async () => {
  const native = new TestTerminals();
  native.input = Promise.withResolvers<void>();
  const owner = new TerminalOwner(native.native, native.api);
  const running = owner.run();
  try {
    const socket = new TestSocket();
    const view = await owner.attach(socket, "one", false);
    const response = await owner.snapshot(view.id, signal);
    await snapshotJSON(response);
    view.ready(Number(response.headers.get("x-terminal-sequence")));
    view.input(new TextEncoder().encode("command\r"));
    assertEquals(socket.messages("input-ack"), []);
    assertThrows(() => view.input(new Uint8Array([1])), Error, "input window");
    native.input.resolve();
    await native.input.promise;
    await Promise.resolve();
    assertEquals(socket.messages("input-ack").length, 1);
    assertEquals(native.writes.length, 1);
    await owner.detach(view);
    assertThrows(() => view.input(new Uint8Array([2])), Error, "input window");
  } finally {
    await owner.close();
    await running;
  }
});

Deno.test("lost output fails the display owner explicitly and a later close still destroys the PTY", async () => {
  const native = new TestTerminals();
  const owner = new TerminalOwner(native.native, native.api);
  const running = owner.run();
  const failure = assertRejects(() => running, Error, "sequence was lost");
  native.emit({ data: new Uint8Array([65]) }, 2);
  await failure;
  assertEquals(native.closed, []);
  await assertRejects(
    () => owner.attach(new TestSocket(), "one", false),
    Error,
    "unavailable",
  );
  await owner.close();
  assertEquals(native.closed, [native.native.terminal.id]);
});

Deno.test("native takeover releases the browser and a blocked view cannot stall canonical output", async () => {
  const native = new TestTerminals();
  const started = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const attachNative = Promise.withResolvers<void>();
  let requested = false;
  const untilAbort = (signal?: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else {signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });}
    });
  const owner = new TerminalOwner(native.native, {
    ...native.api,
    nextView: (_id, signal) => {
      if (requested) return untilAbort(signal);
      requested = true;
      return attachNative.promise.then(() => ({
        viewId: "att-0000000999",
        sequence: 0,
        size: native.native.terminal.size,
      }));
    },
    writeView: (_processor, _view, _data, signal) => {
      started.resolve();
      return untilAbort(signal);
    },
    finishView: () => {
      closed.resolve();
      return Promise.resolve();
    },
  });
  const running = owner.run();
  try {
    const socket = new TestSocket();
    const browser = await owner.attach(socket, "browser", false);
    attachNative.resolve();
    await started.promise;
    assert(browser.closed, "SSH takeover must notify the previous browser");
    assertEquals(
      socket.closed?.code,
      1000,
      "the browser must not reconnect automatically",
    );
    assertEquals(
      socket.messages("error")[0]?.busy,
      true,
      "the browser can explicitly reclaim control",
    );
    for (let i = 0; i < 600; i++) await native.output(`line ${i}\r\n`);
    await closed.promise;
    await native.output("\x1b[6n");
    assertEquals(native.replies.length, 1);
    assertEquals(native.closed, []);
  } finally {
    await owner.close();
    await running;
  }
});
