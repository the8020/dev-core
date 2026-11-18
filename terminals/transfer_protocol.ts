export const UPLOADS = "/root/uploads";
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_FILES = 100;
// deno-lint-ignore no-control-regex
const controls = /[\x00-\x1f\x7f]/;

export function filename(value: unknown): string {
  if (
    typeof value !== "string" || !value.trim() || value.length > 255 ||
    value === "." || value === ".." || /[/\\]/.test(value) ||
    controls.test(value)
  ) throw new Error("Invalid filename");
  return value;
}

export function folder(value: unknown): string {
  if (
    typeof value !== "string" || !value.startsWith("/") ||
    value.length > 4096 || controls.test(value)
  ) {
    throw new Error("Folder must be an absolute sandbox path");
  }
  return value.replace(/\/+$/, "") || "/";
}

export function shellPaths(paths: string[]): string {
  return paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ");
}

/** Small headers and binary bodies share the existing byte-stream transport. */
export class TransferReader {
  #iterator: AsyncIterator<Uint8Array>;
  #pending = new Uint8Array(0);
  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }
  async chunk(): Promise<Uint8Array | undefined> {
    if (this.#pending.length) {
      const value = this.#pending;
      this.#pending = new Uint8Array(0);
      return value;
    }
    const item = await this.#iterator.next();
    return item.done ? undefined : item.value;
  }
  async header(): Promise<Record<string, unknown>> {
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await this.chunk();
      if (!chunk) {
        throw new Error("Transfer ended before its response");
      }
      const end = chunk.indexOf(10);
      const part = end < 0 ? chunk : chunk.subarray(0, end);
      size += part.length;
      if (size > 16384) {
        throw new Error("Transfer header is too large");
      }
      parts.push(part);
      if (end < 0) continue;
      this.#pending = chunk.slice(end + 1);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Invalid transfer header");
      }
      if (typeof value.error === "string") {
        throw new Error(value.error);
      }
      return value;
    }
  }
  async *bytes(size: number): AsyncGenerator<Uint8Array> {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw new Error("File must not exceed 1 GiB");
    }
    while (size > 0) {
      const chunk = await this.chunk();
      if (!chunk) {
        throw new Error("Transfer ended before the complete file");
      }
      const take = Math.min(size, chunk.length);
      if (take < chunk.length) this.#pending = chunk.slice(take);
      size -= take;
      yield chunk.subarray(0, take);
    }
  }
  async close(): Promise<void> {
    await this.#iterator.return?.();
  }
}

export function header(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value) + "\n");
}
