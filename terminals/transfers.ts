import { localizedText } from "/p/the8020/i18n/mod.ts";
import { msg } from "../i18n/messages.ts";
import { DevelopmentError } from "../i18n/errors.ts";
import { kernel } from "@the8020/kernel";
import {
  filename,
  folder,
  header,
  MAX_FILE_BYTES,
  TransferReader,
} from "./transfer_protocol.ts";

/** A short-lived raw process keeps file bytes out of the user's interactive PTY. */
async function process(sandboxId: string, signal: AbortSignal) {
  const terminal = await kernel.terminals.create({
    kind: "development",
    sandboxId,
    workingDir: "/workspace",
    arguments: [
      "/bin/sh",
      "-c",
      "stty raw -echo && exec deno run --quiet --no-config --allow-read --allow-write /workspace/packages/the8020/dev-core/terminals/transfer_files.ts",
    ],
    size: { columns: 80, rows: 24 },
  }, signal);
  const id = terminal.terminal.id;
  try {
    const controller = await kernel.terminals.attach(id, "control", 0, signal);
    const output = async function* () {
      let sequence = 0;
      while (true) {
        const batch = await kernel.terminals.read(
          terminal.attachmentId,
          sequence,
          signal,
        );
        sequence = batch.sequence;
        for (const event of batch.events) if (event.data) yield event.data;
        if (batch.exited) return;
      }
    };
    const reader = new TransferReader(output());
    const write = async (bytes: Uint8Array) => {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        await kernel.terminals.write(
          controller.attachmentId,
          bytes.subarray(offset, offset + 65536),
          signal,
        );
      }
    };
    await reader.header();
    return { reader, write, close: () => kernel.terminals.close(id) };
  } catch (error) {
    await kernel.terminals.close(id);
    throw error;
  }
}

export async function upload(
  sandboxId: string,
  directory: string,
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string> {
  const input = new TransferReader(source);
  let child: Awaited<ReturnType<typeof process>> | undefined;
  try {
    const metadata = await input.header();
    const name = filename(metadata.name);
    directory = folder(directory);
    child = await process(sandboxId, signal);
    await child.write(
      header({
        operation: "upload",
        folder: directory,
        name,
        size: metadata.size,
      }),
    );
    await child.reader.header();
    for await (const bytes of input.bytes(Number(metadata.size))) {
      await child.write(bytes);
    }
    if (await input.chunk()) {
      throw new DevelopmentError("errors.upload_exceeds_the_declared_size");
    }
    await child.write(header({ commit: true }));
    const result = await child.reader.header();
    if (typeof result.path !== "string") {
      throw new DevelopmentError("errors.missing_uploaded_path");
    }
    return result.path;
  } catch (error) {
    if (error instanceof DevelopmentError) {
      error.message = await localizedText(msg(error.textKey));
    }
    throw error;
  } finally {
    await child?.close();
  }
}

export async function* downloadFile(
  sandboxId: string,
  directory: string,
  name: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let child: Awaited<ReturnType<typeof process>> | undefined;
  try {
    directory = folder(directory);
    name = filename(name);
    child = await process(sandboxId, signal);
    await child.write(
      header({ operation: "download", folder: directory, name }),
    );
    const metadata = await child.reader.header();
    await child.write(header({ ready: true }));
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw new DevelopmentError("errors.file_must_not_exceed_1_gib");
    }
    for (let offset = 0; offset < size; offset += 65536) {
      yield* child.reader.bytes(Math.min(65536, size - offset));
      await child.write(header({ ready: true }));
    }
    if (!(await child.reader.header()).complete) {
      throw new DevelopmentError("errors.download_did_not_complete");
    }
  } catch (error) {
    if (error instanceof DevelopmentError) {
      error.message = await localizedText(msg(error.textKey));
    }
    throw error;
  } finally {
    await child?.close();
  }
}
