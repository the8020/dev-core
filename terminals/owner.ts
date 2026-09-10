import {
  kernel,
  type TerminalAttachment,
  TerminalClosedError,
  TerminalControlBusyError,
  type TerminalEvent,
} from "@the8020/kernel";
import type { WebSocketSession } from "@the8020/http";
import { TerminalEngine } from "./engine.ts";
import { MAX_SNAPSHOT_BYTES } from "./state.ts";
import {
  outputFrame,
  VIEW_QUEUE_BYTES,
  VIEW_QUEUE_FRAMES,
  VIEW_WINDOW_BYTES,
} from "./protocol.ts";
import { snapshots } from "./snapshots.ts";
import { NativeTerminalDisplay } from "./native_display.ts";
import { NativeTerminalView } from "./native_view.ts";

type NativeTerminals = typeof kernel.terminals;
const encoder = new TextEncoder();

export class TerminalBusyError extends Error {}

/** One package display owner for one physical PTY. */
export class TerminalOwner {
  readonly engine: TerminalEngine;
  readonly #stop = new AbortController();
  readonly #closing = Promise.withResolvers<void>();
  readonly #finished = Promise.withResolvers<void>();
  readonly finished = this.#finished.promise;
  #ordered: Promise<void> = Promise.resolve();
  #views: Promise<void> = Promise.resolve();
  #sequence = 0;
  #view?: TerminalView;
  #nativeView?: NativeTerminalView;
  #advanced = Promise.withResolvers<void>();
  #failure?: Error;
  #exited = false;
  #exitStatus?: number;
  #closeRequested = false;
  #destruction?: Promise<void>;

  constructor(
    readonly native: TerminalAttachment,
    readonly terminals: NativeTerminals = kernel.terminals,
    after = 0,
    readonly displayReset = false,
  ) {
    this.engine = new TerminalEngine(native.terminal.size);
    this.#sequence = after;
  }

  #order<T>(action: () => Promise<T> | T): Promise<T> {
    const next = this.#ordered.then(action);
    this.#ordered = next.then(() => {}, () => {});
    return next;
  }

  async run(): Promise<void> {
    const failed = (error: unknown) => {
      if (!this.#stop.signal.aborted) {
        if (error instanceof TerminalClosedError) {
          this.#closeRequested = true;
        } else {
          this.#failure = error instanceof Error
            ? error
            : new Error(String(error));
        }
        this.#closing.resolve();
      }
    };
    const drain = this.#drain().catch(failed);
    const nativeViews = this.#acceptNativeViews().catch(failed);
    try {
      await this.#closing.promise;
      this.#stop.abort();
      this.#advanced.resolve();
      this.#nativeView?.close();
      this.#view?.close(
        1000,
        this.#closeRequested
          ? "Terminal closed"
          : "Terminal display unavailable",
      );
      if (this.#closeRequested) await this.#destroy();
      await drain;
      if (this.#failure) throw this.#failure;
    } finally {
      try {
        this.#stop.abort();
        this.#advanced.resolve();
        this.#nativeView?.close();
        this.#view?.close(1000, "Terminal detached");
        await drain;
        await nativeViews;
        await this.#views;
        if (this.#view) {
          await this.terminals.detach(this.#view.attachment.attachmentId);
        }
      } finally {
        try {
          await this.terminals.detach(this.native.attachmentId);
        } finally {
          try {
            await this.engine.close();
          } finally {
            this.#finished.resolve();
          }
        }
      }
    }
  }

  async #drain(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      const batch = await this.terminals.read(
        this.native.attachmentId,
        this.#sequence,
        this.#stop.signal,
      );
      if (batch.events.length) {
        await this.#order(async () => {
          for (let index = 0; index < batch.events.length; index++) {
            if (batch.events[index]!.sequence !== this.#sequence + index + 1) {
              throw new Error("Terminal output sequence was lost");
            }
          }
          const replies = await this.engine.applyBatch(batch.events);
          for (let index = 0; index < batch.events.length; index++) {
            const event = batch.events[index]!;
            const reply = replies[index];
            this.#sequence = event.sequence;
            if (reply) {
              await this.terminals.respond(
                this.native.attachmentId,
                reply,
                this.#stop.signal,
              );
            }
            this.#view?.enqueue(event);
          }
          this.#nativeView?.update();
          this.#advanced.resolve();
          this.#advanced = Promise.withResolvers<void>();
        });
      }
      if (batch.exited) {
        this.#exited = true;
        this.#exitStatus = batch.exitStatus;
        this.#view?.state(this.state());
        this.#nativeView?.finish();
        return;
      }
    }
  }

  async #acceptNativeViews(): Promise<void> {
    while (!this.#stop.signal.aborted) {
      const request = await this.terminals.nextView(
        this.native.attachmentId,
        this.#stop.signal,
      );
      while (this.#sequence < request.sequence) {
        this.#stop.signal.throwIfAborted();
        await this.#advanced.promise;
      }
      let release = () => {};
      try {
        release = await snapshots.acquire(
          AbortSignal.any([this.#stop.signal, AbortSignal.timeout(120_000)]),
        );
        await this.#order(() => {
          this.#stop.signal.throwIfAborted();
          this.#view?.send(JSON.stringify({
            type: "error",
            message: "Terminal control transferred to another connection",
            busy: true,
          }));
          this.#view?.close(1000, "Terminal control transferred");
          this.#nativeView?.close();
          const display = new NativeTerminalDisplay(this.engine);
          try {
            this.#nativeView = new NativeTerminalView(
              display,
              this.native.attachmentId,
              request.viewId,
              this.terminals,
              this.#stop.signal,
              release,
            );
          } catch (error) {
            display.close();
            throw error;
          }
          if (this.#exited) this.#nativeView.finish();
        });
      } catch {
        release();
        await this.terminals.finishView(
          this.native.attachmentId,
          request.viewId,
        ).catch(() => {});
      }
    }
  }

  state(): { exited: boolean; exitStatus?: number; displayReset: boolean } {
    return {
      exited: this.#exited,
      displayReset: this.displayReset,
      ...(this.#exitStatus === undefined
        ? {}
        : { exitStatus: this.#exitStatus }),
    };
  }

  #destroy(): Promise<void> {
    return this.#destruction ??= this.terminals.close(this.native.terminal.id);
  }

  async close(): Promise<void> {
    this.#closeRequested = true;
    this.#closing.resolve();
    await this.finished;
    await this.#destroy();
  }

  attach(
    socket: WebSocketSession,
    clientId: string,
    takeover: boolean,
  ): Promise<TerminalView> {
    const result = this.#views.then(async () => {
      if (this.#failure || this.#stop.signal.aborted) {
        throw new Error("Terminal display owner is unavailable");
      }
      const previous = this.#view;
      if (previous) {
        if (!previous.closed && previous.clientId !== clientId && !takeover) {
          throw new TerminalBusyError(
            "This terminal is controlled in another window",
          );
        }
        previous.close(1000, "Terminal control transferred");
        await this.terminals.detach(previous.attachment.attachmentId);
      }
      const attachment = await this.terminals.attach(
        this.native.terminal.id,
        takeover ? "take-control" : "control",
        0,
        AbortSignal.any([socket.signal, this.#stop.signal]),
      ).catch((error) => {
        if (error instanceof TerminalControlBusyError) {
          throw new TerminalBusyError(
            "This terminal is controlled by another connection",
          );
        }
        throw error;
      });
      this.#nativeView?.close();
      if (this.#stop.signal.aborted || socket.signal.aborted) {
        await this.terminals.detach(attachment.attachmentId);
        throw new Error("Terminal attachment ended");
      }
      const view = new TerminalView(this, socket, clientId, attachment);
      this.#view = view;
      return view;
    });
    this.#views = result.then(() => {}, () => {});
    return result;
  }

  async detach(view: TerminalView): Promise<void> {
    view.close(1000, "Terminal detached");
    await this.terminals.detach(view.attachment.attachmentId);
    if (this.#view === view) this.#view = undefined;
  }

  async snapshot(viewId: string, signal: AbortSignal): Promise<Response> {
    const view = this.#view;
    if (!view || view.id !== viewId || view.closed || view.snapshotStarted) {
      return new Response("Terminal attachment unavailable", { status: 409 });
    }
    view.snapshotStarted = true;
    const recovery = AbortSignal.any([
      signal,
      view.signal,
      AbortSignal.timeout(120_000),
    ]);
    let release = () => {};
    try {
      release = await snapshots.acquire(recovery);
      const { snapshot, sequence } = await this.#order(async () => {
        recovery.throwIfAborted();
        const snapshot = await this.engine.capture();
        view.seed(this.#sequence);
        return { snapshot, sequence: this.#sequence };
      });
      const data = encoder.encode(JSON.stringify(snapshot));
      if (data.byteLength > MAX_SNAPSHOT_BYTES) {
        view.close(1011, "Terminal display exceeds recovery limit");
        throw new Error("Terminal snapshot exceeds its byte limit");
      }
      recovery.throwIfAborted();
      return new Response(snapshots.stream(data, recovery, release), {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "cache-control": "no-store",
          "x-terminal-sequence": String(sequence),
          "x-terminal-bytes": String(data.byteLength),
        },
      });
    } catch (error) {
      release();
      view.close(1011, "Terminal display recovery failed");
      throw error;
    }
  }
}

/** One controller, with application-consumption credit independent of the PTY owner. */
export class TerminalView {
  readonly id = crypto.randomUUID();
  readonly #queue: Array<{ event: TerminalEvent; bytes: number }> = [];
  readonly #inFlight: Array<{ sequence: number; bytes: number }> = [];
  #bytes = 0;
  #sentBytes = 0;
  #acknowledged = 0;
  #sent = 0;
  #seeded = false;
  #ready = false;
  #inputPending = false;
  #closed = false;
  readonly #lifetime = new AbortController();
  snapshotStarted = false;

  constructor(
    readonly owner: TerminalOwner,
    readonly socket: WebSocketSession,
    readonly clientId: string,
    readonly attachment: TerminalAttachment,
  ) {}

  get closed(): boolean {
    return this.#closed || this.socket.signal.aborted;
  }
  get signal(): AbortSignal {
    return AbortSignal.any([this.#lifetime.signal, this.socket.signal]);
  }

  seed(sequence: number): void {
    this.#acknowledged = this.#sent = sequence;
    this.#seeded = true;
  }

  enqueue(event: TerminalEvent): void {
    if (!this.#seeded || this.closed) return;
    const bytes = (event.data?.byteLength ?? 0) + 64;
    if (
      bytes > VIEW_WINDOW_BYTES || this.#bytes + bytes > VIEW_QUEUE_BYTES ||
      this.#queue.length + this.#inFlight.length >= VIEW_QUEUE_FRAMES
    ) {
      this.close(1009, "Terminal view fell behind; reconnect to recover");
      return;
    }
    this.#queue.push({ event, bytes });
    this.#bytes += bytes;
    this.#flush();
  }

  #flush(): void {
    while (this.#ready && !this.closed && this.#queue.length) {
      const next = this.#queue[0]!;
      if (
        this.#sentBytes + next.bytes > VIEW_WINDOW_BYTES ||
        this.#inFlight.length >= 64
      ) return;
      this.#queue.shift();
      const { event, bytes } = next;
      const data = event.data
        ? outputFrame(event.sequence, event.data)
        : JSON.stringify({
          type: "resize",
          sequence: event.sequence,
          size: event.size,
        });
      if (!this.send(data)) return;
      this.#inFlight.push({ sequence: event.sequence, bytes });
      this.#sentBytes += bytes;
      this.#sent = event.sequence;
    }
  }

  ready(sequence: number): void {
    if (!this.#seeded || this.#ready || sequence !== this.#acknowledged) {
      throw new Error("Invalid terminal snapshot acknowledgement");
    }
    this.#ready = true;
    this.send(JSON.stringify({ type: "ready", ...this.owner.state() }));
    this.#flush();
  }

  acknowledge(sequence: number): void {
    if (
      !Number.isSafeInteger(sequence) || sequence < this.#acknowledged ||
      sequence > this.#sent
    ) throw new Error("Invalid terminal output acknowledgement");
    this.#acknowledged = sequence;
    while (this.#inFlight[0] && this.#inFlight[0].sequence <= sequence) {
      const frame = this.#inFlight.shift()!;
      this.#bytes -= frame.bytes;
      this.#sentBytes -= frame.bytes;
    }
    this.#flush();
  }

  input(data: Uint8Array): void {
    if (!this.#ready || this.#inputPending || this.closed) {
      throw new Error("Terminal input window is unavailable");
    }
    this.#inputPending = true;
    if (data.byteLength < 1 || data.byteLength > 65_536) {
      throw new Error("Terminal input exceeds its frame limit");
    }
    void this.owner.terminals.write(
      this.attachment.attachmentId,
      data,
      this.signal,
    ).then(() => {
      this.#inputPending = false;
      this.send(JSON.stringify({ type: "input-ack" }));
    }, () => this.close(1011, "Terminal input failed; its outcome is unknown"));
  }

  state(state: { exited: boolean; exitStatus?: number }): void {
    this.send(JSON.stringify({ type: "state", ...state }));
  }

  send(data: string | Uint8Array): boolean {
    if (this.closed) return false;
    try {
      this.socket.send(data);
      return true;
    } catch {
      this.close(1011, "Terminal connection failed");
      return false;
    }
  }

  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort();
    this.#queue.length = this.#inFlight.length = 0;
    this.#bytes = this.#sentBytes = 0;
    try {
      this.socket.close(code, reason);
    } catch { /* The transport may already be gone. */ }
  }
}
