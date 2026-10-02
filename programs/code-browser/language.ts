import { kernel } from "@the8020/kernel";
import { readSource, sourceText, sourceURI } from "./files.ts";

type Message = {
  id?: number;
  method?: string;
  params?: { items?: unknown[]; message?: string };
  result?: unknown;
  error?: { message: string };
};

/** LSP lengths count bytes, including when a terminal read splits a UTF-8 character. */
export class Frames {
  #bytes = new Uint8Array();
  push(chunk: Uint8Array): Message[] {
    const bytes = new Uint8Array(this.#bytes.length + chunk.length);
    bytes.set(this.#bytes);
    bytes.set(chunk, this.#bytes.length);
    this.#bytes = bytes;
    const messages: Message[] = [];
    while (true) {
      let end = -1;
      for (let i = 0; i < this.#bytes.length - 3; i++) {
        if (
          this.#bytes[i] === 13 && this.#bytes[i + 1] === 10 &&
          this.#bytes[i + 2] === 13 && this.#bytes[i + 3] === 10
        ) {
          end = i;
          break;
        }
      }
      if (end < 0) {
        if (this.#bytes.length > 8192) {
          throw new Error("Invalid language server header.");
        }
        break;
      }
      const header = new TextDecoder().decode(this.#bytes.subarray(0, end));
      const size = Number(header.match(/^Content-Length: (\d+)\r?$/im)?.[1]);
      if (!Number.isSafeInteger(size) || size < 0 || size > 4 * 1024 * 1024) {
        throw new Error("Language server response exceeds its limit.");
      }
      if (this.#bytes.length < end + 4 + size) break;
      messages.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
        this.#bytes.subarray(end + 4, end + 4 + size),
      )));
      this.#bytes = this.#bytes.slice(end + 4 + size);
    }
    return messages;
  }
}

export function frame(message: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new TextEncoder().encode(
    `Content-Length: ${body.length}\r\n\r\n`,
  );
  const result = new Uint8Array(header.length + body.length);
  result.set(header);
  result.set(body, header.length);
  return result;
}

/** One Deno language server, owned and closed by this interactive program. */
export class LanguageServer {
  #terminal = "";
  #controller = "";
  #stop = new AbortController();
  #reading = Promise.resolve();
  #writing = Promise.resolve();
  #sequence = 0;
  #pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  #documents = new Map<string, string>();
  #failure?: Error;
  #config = "";
  warning = "";

  async start(
    sandboxId: string,
    packages: string[],
    project: string,
  ): Promise<void> {
    this.#config = `/workspace/packages/${project}/deno.json`;
    const ready = '{"jsonrpc":"2.0","id":0,"result":true}';
    const started = new Promise((resolve, reject) =>
      this.#pending.set(0, { resolve, reject })
    );
    // Raw mode is acknowledged before any request, avoiding PTY echo/startup races.
    const terminal = await kernel.terminals.create({
      kind: "development",
      sandboxId,
      arguments: [
        "/bin/sh",
        "-c",
        `stty raw -echo && printf 'Content-Length: ${ready.length}\\r\\n\\r\\n${ready}' && exec deno lsp 2>/dev/null`,
      ],
      environment: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/root"],
      workingDir: `/workspace/packages/${project}`,
      size: { columns: 80, rows: 24 },
    }, this.#stop.signal);
    this.#terminal = terminal.terminal.id;
    try {
      this.#controller = (await kernel.terminals.attach(
        this.#terminal,
        "control",
        0,
        this.#stop.signal,
      )).attachmentId;
      this.#reading = this.#read(terminal.attachmentId).catch((error) => {
        this.#failure = error instanceof Error
          ? error
          : new Error(String(error));
        for (const waiter of this.#pending.values()) {
          waiter.reject(this.#failure);
        }
        this.#pending.clear();
      });
      await Promise.race([
        started,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Language server did not start.")),
            10000,
          );
          started.finally(() => clearTimeout(timer)).catch(() => {});
        }),
      ]);
      await this.request("initialize", {
        processId: null,
        rootUri: `file:///workspace/packages/${project}`,
        workspaceFolders: packages.map((path) => ({
          name: path,
          uri: `file:///workspace/packages/${path}`,
        })),
        capabilities: {
          textDocument: {
            definition: { linkSupport: true },
            hover: { contentFormat: ["plaintext"] },
          },
        },
        initializationOptions: {
          enable: true,
          lint: false,
          config: this.#config,
        },
      });
      await this.#send({ jsonrpc: "2.0", method: "initialized", params: {} });
      await this.#openRuntime();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async #openRuntime(path = ""): Promise<void> {
    const source = await readSource("/opt/runtime", path);
    if (source.entries) {
      for (const entry of source.entries) {
        if (entry.kind === "Folder" || entry.path.endsWith(".ts")) {
          await this.#openRuntime(entry.path);
        }
      }
    } else {
      if (source.content === undefined) throw new Error(source.notice);
      // LSP open documents also resolve imports when the SDK is absent on disk.
      await this.open(
        sourceURI(`@runtime/${path}`),
        sourceText(source.content),
      );
    }
  }

  async #read(attachment: string): Promise<void> {
    const frames = new Frames();
    let after = 0;
    while (!this.#stop.signal.aborted) {
      const batch = await kernel.terminals.read(
        attachment,
        after,
        this.#stop.signal,
      );
      after = batch.sequence;
      for (const event of batch.events) {
        if (!event.data) continue;
        for (const message of frames.push(event.data)) {
          if (message.method && message.id !== undefined) {
            await this.#send({
              jsonrpc: "2.0",
              id: message.id,
              result: message.method === "workspace/configuration"
                ? message.params?.items?.map(() => ({
                  enable: true,
                  lint: false,
                  config: this.#config,
                }))
                : null,
            });
          } else if (message.id !== undefined) {
            const waiter = this.#pending.get(message.id);
            this.#pending.delete(message.id);
            if (message.error) waiter?.reject(new Error(message.error.message));
            else waiter?.resolve(message.result);
          } else if (message.method === "window/showMessage") {
            this.warning = message.params?.message?.slice(0, 500) ?? "";
          }
        }
      }
      if (batch.exited) {
        throw new Error("Language server stopped. Refresh to reconnect.");
      }
    }
  }

  #send(message: unknown): Promise<void> {
    const bytes = frame(message);
    this.#writing = this.#writing.then(async () => {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        await kernel.terminals.write(
          this.#controller,
          bytes.subarray(offset, offset + 65536),
          this.#stop.signal,
        );
      }
    });
    return this.#writing;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#failure) throw this.#failure;
    const id = ++this.#sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      timer = setTimeout(
        () =>
          reject(new Error("Language query timed out. Try again or Refresh.")),
        30000,
      );
    });
    try {
      const [, result] = await Promise.all([
        this.#send({ jsonrpc: "2.0", id, method, params }),
        response,
      ]);
      return result;
    } finally {
      clearTimeout(timer);
      this.#pending.delete(id);
    }
  }

  async open(uri: string, text: string): Promise<void> {
    const previous = this.#documents.get(uri);
    if (previous === text) return;
    if (previous !== undefined) {
      await this.#send({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: { textDocument: { uri } },
      });
    }
    this.#documents.set(uri, text);
    await this.#send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: /\.[cm]?jsx?$/i.test(uri) ? "javascript" : "typescript",
          version: 1,
          text,
        },
      },
    });
  }

  async close(): Promise<void> {
    this.#stop.abort();
    if (this.#terminal) {
      const id = this.#terminal;
      this.#terminal = "";
      await kernel.terminals.close(id);
    }
    await this.#reading;
  }

  async closeDocument(uri: string): Promise<void> {
    if (uri.startsWith("file:///opt/runtime/")) return;
    if (!this.#documents.delete(uri)) return;
    await this.#send({
      jsonrpc: "2.0",
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    });
  }
}
