/** Limit simultaneous recovery allocations across all terminal owners in a Worker. */
export class SnapshotBudget {
  #active = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(readonly capacity = 2, readonly maximumWaiting = 32) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.#active >= this.capacity) {
      if (this.#waiting.length >= this.maximumWaiting) {
        throw new Error("Terminal recovery queue is full");
      }
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = this.#waiting.indexOf(ready);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(signal.reason);
        };
        this.#waiting.push(ready);
        signal.addEventListener("abort", abort, { once: true });
      });
    } else this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active--;
    };
  }

  stream(
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
    release: () => void,
  ): ReadableStream<Uint8Array<ArrayBuffer>> {
    let remaining: Uint8Array<ArrayBuffer> | undefined = bytes;
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        if (!remaining?.byteLength) {
          remaining = undefined;
          controller.close();
          return;
        }
        controller.enqueue(remaining.subarray(0, 65_536));
        remaining = remaining.subarray(65_536);
      },
      cancel() {
        remaining = undefined;
      },
    });
    const reader = source.pipeThrough(new CompressionStream("gzip"), { signal })
      .getReader();
    let finished = false;
    let output: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    const finish = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", abort);
      remaining = undefined;
      release();
    };
    const abort = () => {
      if (finished) return;
      output.error(signal.reason);
      void reader.cancel(signal.reason).catch(() => {});
      finish();
    };
    return new ReadableStream({
      start(controller) {
        output = controller;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const result = await reader.read();
          if (finished) return;
          if (result.done) {
            controller.close();
            finish();
          } else controller.enqueue(result.value);
        } catch (error) {
          if (!finished) controller.error(error);
          finish();
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    });
  }
}

export const snapshots = new SnapshotBudget();
