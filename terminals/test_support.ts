import type {
  kernel,
  TerminalAttachment,
  TerminalBatch,
  TerminalEvent,
} from "@the8020/kernel";
import type {
  WebSocketData,
  WebSocketInboundEvent,
  WebSocketSession,
} from "@the8020/http";
import { TERMINAL_PROTOCOL } from "./protocol.ts";

export class TestSocket implements WebSocketSession {
  readonly protocol = TERMINAL_PROTOCOL;
  readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  readonly sent: WebSocketData[] = [];
  readonly #sentWaiters: Array<
    { type: string; resolve: (value: Record<string, unknown>) => void }
  > = [];
  readonly #incoming: WebSocketInboundEvent[] = [];
  #receive?: (value: WebSocketInboundEvent) => void;
  failSend = false;
  closed?: { code: number; reason: string };

  send(data: WebSocketData): void {
    if (this.failSend) throw new Error("Disconnected transport");
    this.sent.push(data);
    if (typeof data === "string") {
      const value = JSON.parse(data) as Record<string, unknown>;
      for (const waiter of [...this.#sentWaiters]) {
        if (value.type === waiter.type) {
          this.#sentWaiters.splice(this.#sentWaiters.indexOf(waiter), 1);
          waiter.resolve(value);
        }
      }
    }
  }
  receive(): Promise<WebSocketInboundEvent> {
    const incoming = this.#incoming.shift();
    if (incoming) return Promise.resolve(incoming);
    if (this.closed) return Promise.resolve({ type: "close", ...this.closed });
    return new Promise((resolve) => this.#receive = resolve);
  }
  #push(event: WebSocketInboundEvent): void {
    if (this.#receive) {
      const resolve = this.#receive;
      this.#receive = undefined;
      resolve(event);
    } else this.#incoming.push(event);
  }
  message(data: Record<string, unknown> | Uint8Array): void {
    this.#push({
      type: "message",
      data: data instanceof Uint8Array ? data : JSON.stringify(data),
    });
  }
  close(code = 1000, reason = "Disconnected"): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.abort.abort();
    this.#push({ type: "close", code, reason });
  }
  messages(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((data) => typeof data === "string").map((data) =>
      JSON.parse(data as string)
    ).filter((data) => data.type === type);
  }

  messageOfType(type: string): Promise<Record<string, unknown>> {
    const value = this.messages(type).at(-1);
    return value
      ? Promise.resolve(value)
      : new Promise((resolve) => this.#sentWaiters.push({ type, resolve }));
  }
}

export class TestTerminals {
  readonly native: TerminalAttachment = {
    attachmentId: "att-0000000001",
    terminal: {
      id: "tty-0000000001",
      kind: "development",
      sandboxId: "sbx-0000000001",
      size: { columns: 80, rows: 24 },
      sequence: 0,
      exited: false,
    },
  };
  readonly events: TerminalEvent[] = [];
  readonly replies: Uint8Array[] = [];
  readonly writes: Uint8Array[] = [];
  readonly detached: string[] = [];
  readonly closed: string[] = [];
  created = 0;
  input?: ReturnType<typeof Promise.withResolvers<void>>;
  #pulse = Promise.withResolvers<void>();
  #readAfter = 0;
  #attachment = 1;
  #exited = false;
  #waiters: Array<{ after: number; resolve: () => void }> = [];

  readonly api: typeof kernel.terminals = {
    create: () => {
      this.created++;
      return Promise.resolve(this.native);
    },
    list: () => Promise.resolve([this.native.terminal]),
    inspect: () => Promise.resolve(this.native.terminal),
    nextView: async (_id, signal) => {
      await wait(this.#noViews.promise, signal);
      throw new Error("No native views");
    },
    writeView: () => Promise.reject(new Error("No native view")),
    finishView: () => Promise.resolve(),
    attach: () =>
      Promise.resolve({
        terminal: this.native.terminal,
        attachmentId: `att-${String(++this.#attachment).padStart(10, "0")}`,
      }),
    detach: (id) => {
      this.detached.push(id);
      return Promise.resolve();
    },
    close: (target) => {
      const id = typeof target === "string" ? target : target.terminalId;
      this.closed.push(id);
      this.#notify();
      return Promise.resolve();
    },
    read: (_id, after, signal) => this.#read(after, signal),
    write: (_id, data, signal) => {
      this.writes.push(data.slice());
      return this.input ? wait(this.input.promise, signal) : Promise.resolve();
    },
    respond: (_id, data) => {
      this.replies.push(data.slice());
      return Promise.resolve();
    },
    resize: (_id, size) => {
      this.emit({ size });
      return Promise.resolve();
    },
  };
  readonly #noViews = Promise.withResolvers<void>();

  #notify(): void {
    const pulse = this.#pulse;
    this.#pulse = Promise.withResolvers<void>();
    pulse.resolve();
  }
  emit(
    event: Omit<TerminalEvent, "sequence">,
    sequence = this.events.length + 1,
  ): number {
    this.events.push({ sequence, ...event });
    this.#notify();
    return sequence;
  }
  exit(): void {
    this.#exited = true;
    this.#notify();
  }
  processed(after: number): Promise<void> {
    if (this.#readAfter >= after) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push({ after, resolve }));
  }
  async output(data: string | Uint8Array): Promise<void> {
    const after = this.emit({
      data: typeof data === "string" ? new TextEncoder().encode(data) : data,
    });
    await this.processed(after);
  }
  async #read(after: number, signal?: AbortSignal): Promise<TerminalBatch> {
    this.#readAfter = after;
    for (const waiter of this.#waiters) {
      if (after >= waiter.after) waiter.resolve();
    }
    this.#waiters = this.#waiters.filter((waiter) => waiter.after > after);
    for (;;) {
      signal?.throwIfAborted();
      if (this.closed.length) throw new Error("Terminal gone");
      const events = this.events.filter((event) => event.sequence > after);
      if (events.length || this.#exited) {
        return {
          events,
          sequence: events.at(-1)?.sequence ?? after,
          exited: this.#exited,
        };
      }
      await wait(this.#pulse.promise, signal);
    }
  }
}

function wait(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

export async function snapshotJSON(response: Response): Promise<unknown> {
  return await new Response(
    response.body!.pipeThrough(new DecompressionStream("gzip")),
  ).json();
}
