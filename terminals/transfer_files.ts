// Executed inside the authenticated developer's sandbox, never in a Worker.
import {
  filename,
  folder,
  header,
  TransferReader,
} from "./transfer_protocol.ts";

export async function receiveFile(
  directory: string,
  name: string,
  source: AsyncIterable<Uint8Array>,
): Promise<string> {
  directory = folder(directory);
  name = filename(name);
  await Deno.mkdir(directory, { recursive: true });
  const temporary = await Deno.makeTempFile({
    dir: directory,
    prefix: ".upload-",
  });
  const cleanup = async () => {
    await Deno.remove(temporary).catch(() => {});
  };
  const terminate = () => void cleanup().finally(() => Deno.exit(143));
  if (import.meta.main) {
    Deno.addSignalListener("SIGTERM", terminate);
    Deno.addSignalListener("SIGHUP", terminate);
  }
  try {
    const file = await Deno.open(temporary, { write: true });
    try {
      for await (const chunk of source) {
        let offset = 0;
        while (offset < chunk.length) {
          offset += await file.write(chunk.subarray(offset));
        }
      }
    } finally {
      file.close();
    }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    for (let index = 0; index < 10000; index++) {
      const path = `${directory}/${
        index ? `${stem} (${index})${extension}` : name
      }`;
      try {
        // Publish complete bytes without replacing an existing file or symlink.
        await Deno.link(temporary, path);
        return path;
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      }
    }
    throw new Error("Too many files with this name");
  } finally {
    if (import.meta.main) {
      Deno.removeSignalListener("SIGTERM", terminate);
      Deno.removeSignalListener("SIGHUP", terminate);
    }
    await cleanup();
  }
}

async function write(bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    offset += await Deno.stdout.write(bytes.subarray(offset));
  }
}

if (import.meta.main) {
  try {
    const input = new TransferReader(Deno.stdin.readable);
    await write(header({ ready: true }));
    const request = await input.header();
    const directory = folder(request.folder);
    const name = filename(request.name);
    if (request.operation === "upload") {
      await write(header({ ready: true }));
      const source = async function* () {
        yield* input.bytes(Number(request.size));
        if (!(await input.header()).commit) {
          throw new Error("Upload was not completed");
        }
      };
      const path = await receiveFile(directory, name, source());
      await write(header({ path }));
    } else if (request.operation === "download") {
      if (!(await Deno.stat(`${directory}/${name}`)).isFile) {
        throw new Error("Choose a regular file");
      }
      const file = await Deno.open(`${directory}/${name}`, { read: true });
      try {
        const info = await file.stat();
        if (!info.isFile) {
          throw new Error("Choose a regular file");
        }
        await write(header({ size: info.size }));
        if (!(await input.header()).ready) {
          throw new Error("Download was not accepted");
        }
        let remaining = info.size;
        const buffer = new Uint8Array(65536);
        while (remaining > 0) {
          const count = Math.min(remaining, buffer.length);
          let read = 0;
          while (read < count) {
            const size = await file.read(buffer.subarray(read, count));
            if (size === null) {
              throw new Error("File changed during download");
            }
            read += size;
          }
          await write(buffer.subarray(0, count));
          remaining -= count;
          // Native terminal history is bounded; admit one file chunk at a time.
          if (!(await input.header()).ready) {
            throw new Error("Download was cancelled");
          }
        }
        await write(header({ complete: true }));
      } finally {
        file.close();
      }
    } else throw new Error("Invalid transfer operation");
  } catch (error) {
    await write(
      header({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    Deno.exitCode = 1;
  }
}
