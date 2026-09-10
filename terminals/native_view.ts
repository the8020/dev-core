import type { kernel } from "@the8020/kernel";
import {
  nativeDisplayCleanup,
  NativeTerminalDisplay,
} from "./native_display.ts";

const encoder = new TextEncoder();
const deltaLimit = 1 << 20;

/** The native transport consumes its own bounded queue, never the parser queue. */
export class NativeTerminalView {
  readonly #stop = new AbortController();
  readonly #signal: AbortSignal;
  readonly #queue: Uint8Array[] = [];
  #bytes = 0;
  #sending = false;
  #ended = false;
  #closed = false;
  #initial = true;
  #redrawTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly display: NativeTerminalDisplay,
    readonly processorId: string,
    readonly id: string,
    readonly native: typeof kernel.terminals,
    signal: AbortSignal,
    readonly releaseSnapshot: () => void,
  ) {
    this.#signal = AbortSignal.any([signal, this.#stop.signal]);
    this.update();
  }

  get closed(): boolean {
    return this.#closed;
  }

  update(): void {
    if (this.#closed) return;
    if (this.display.engine.terminal.modes.synchronizedOutputMode) {
      // Match xterm's one-second render deadline for an unfinished DEC 2026 frame.
      this.#redrawTimer ??= setTimeout(() => this.#render(), 1000);
      return;
    }
    this.#render();
  }

  #render(): void {
    clearTimeout(this.#redrawTimer);
    this.#redrawTimer = undefined;
    try {
      if (this.#initial) {
        this.#initial = false;
        // Initial recovery is separately bounded by the display snapshot limit.
        void this.#send(encoder.encode(this.display.initial()));
      } else this.#enqueue(this.display.update());
    } catch {
      this.close();
    }
  }

  finish(): void {
    if (this.#ended || this.#closed) return;
    if (this.#redrawTimer !== undefined) this.#render();
    if (this.#closed) return;
    this.#enqueue(nativeDisplayCleanup);
    this.#ended = true;
    if (!this.#sending) void this.#send();
  }

  #enqueue(text: string): void {
    const data = encoder.encode(text);
    if (
      this.#bytes + data.byteLength > deltaLimit || this.#queue.length >= 512
    ) {
      this.close();
      return;
    }
    this.#bytes += data.byteLength;
    this.#queue.push(data);
    if (!this.#sending) void this.#send();
  }

  async #send(initial?: Uint8Array): Promise<void> {
    this.#sending = true;
    const recovery = initial ? AbortSignal.timeout(120_000) : undefined;
    try {
      let data = initial;
      do {
        if (data) {
          for (let offset = 0; offset < data.byteLength; offset += 65_536) {
            await this.native.writeView(
              this.processorId,
              this.id,
              data.subarray(offset, offset + 65_536),
              AbortSignal.any([
                this.#signal,
                AbortSignal.timeout(10_000),
                ...(data === initial && recovery ? [recovery] : []),
              ]),
            );
          }
          if (data === initial) {
            initial = undefined;
            this.releaseSnapshot();
          }
        }
        data = this.#queue.shift();
        if (data) this.#bytes -= data.byteLength;
      } while (data);
      if (this.#ended) {
        await this.native.finishView(this.processorId, this.id, this.#signal);
        this.close();
      }
    } catch {
      this.close();
    } finally {
      this.#sending = false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#redrawTimer);
    this.#stop.abort();
    this.releaseSnapshot();
    this.#queue.length = 0;
    this.#bytes = 0;
    this.display.close();
    // End an idle stream too. Cancelling an in-flight native write already
    // detaches that view; neither path owns physical process destruction.
    void this.native.finishView(this.processorId, this.id).catch(() => {});
  }
}
