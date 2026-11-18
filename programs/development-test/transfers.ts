import {
  BACK_EVENT,
  callScreen,
  Channel,
  copyText,
  download,
  field,
  Model,
  nextScreenChannel,
  packageAssetURL,
  sendMessage,
  z,
} from "/p/the8020/uui/mod.ts";
import { currentLocalization, text } from "/p/the8020/i18n/mod.ts";
import { msg } from "../../i18n/messages.ts";
import assets from "../../terminals/assets.json" with { type: "json" };
import { downloadFile, upload } from "../../terminals/transfers.ts";
import {
  filename,
  folder,
  MAX_FILES,
  shellPaths,
  UPLOADS,
} from "../../terminals/transfer_protocol.ts";

export function terminalUploads(sandboxId: string): Channel {
  const channel = new Channel();
  let receiving = false;
  channel.subscribe("upload", async (_id, data, { signal }) => {
    if (!(data instanceof ReadableStream) || receiving) {
      throw new Error("Invalid upload");
    }
    const reply = channel.capture();
    receiving = true;
    try {
      const path = await upload(sandboxId, UPLOADS, data, signal);
      reply.send("uploaded", path);
    } finally {
      receiving = false;
    }
  });
  return channel;
}

export async function transferDialog(
  sandboxId: string,
  mode: "upload" | "download",
): Promise<void> {
  const model = new Model({ folder: UPLOADS, files: "", result: "" });
  const paths: string[] = [];
  let start = "";
  let done = false;
  while (true) {
    const screen = nextScreenChannel();
    const channel = new Channel();
    let receiving = false;
    const directory = model.data.folder;
    channel.subscribe("upload", async (_id, data, { signal }) => {
      if (
        !start || done || receiving || paths.length >= MAX_FILES ||
        !(data instanceof ReadableStream)
      ) {
        throw new Error("Invalid upload");
      }
      receiving = true;
      try {
        paths.push(await upload(sandboxId, directory, data, signal));
      } finally {
        receiving = false;
      }
    });
    const pending = callScreen({
      id: "sandbox-file-transfer",
      title: msg(mode === "upload" ? "transfer.upload" : "transfer.download"),
      schema: z.object({
        folder: field(z.string().min(1), {
          label: msg("transfer.folder"),
          readOnly: !!start || done,
          length: "long",
        }),
        files: field(z.string(), {
          label: msg(
            mode === "upload" ? "transfer.files" : "transfer.file_lines",
          ),
          ...(mode === "upload" && !done
            ? {
              custom: {
                module: packageAssetURL("the8020/dev-core", assets.module),
                preserve: true,
                channel,
                config: {
                  transferPicker: true,
                  start,
                  texts: Object.fromEntries(
                    Object.entries(
                      (await currentLocalization()?.bundle("the8020/dev-core"))
                        ?.texts ?? {},
                    ).filter(([key]) =>
                      key.startsWith("frontend.") ||
                      key.startsWith("console.") ||
                      key.startsWith("transfer.")
                    ),
                  ),
                },
              },
            }
            : {
              control: "textarea" as const,
              readOnly: !!start || done,
              length: "long" as const,
              rowSpan: 2,
            }),
        }),
        result: field(z.string(), {
          label: msg("transfer.result"),
          control: "textarea",
          readOnly: true,
          length: "long",
          rowSpan: 2,
        }),
      }),
      model,
      actions: done
        ? mode === "upload" && paths.length
          ? [{ id: "copy", label: msg("transfer.copy_paths") }]
          : []
        : start
        ? []
        : [{ id: "confirm", label: msg("transfer.confirm"), kind: "primary" }],
    });
    if (start && !done && mode === "download") {
      const output = screen.downloads;
      void (async () => {
        try {
          for (const name of model.data.files.split("\n").filter(Boolean)) {
            await download({
              filename: name,
              body: downloadFile(sandboxId, directory, name, output.signal),
            }, output).done;
            paths.push(`${directory}/${name}`);
          }
          screen.exit("transferred");
        } catch (error) {
          if (!screen.signal.aborted) {
            model.data.result = String(error);
            screen.exit("transfer-failed");
          }
        }
      })();
    }
    const event = await pending;
    if (event.action === BACK_EVENT) return;
    if (event.action === "copy") {
      copyText(shellPaths(paths));
      continue;
    }
    if (event.action === "confirm") {
      try {
        model.data.folder = folder(model.data.folder);
        const names = model.data.files.split("\n").filter(Boolean);
        if (!names.length || names.length > MAX_FILES) {
          throw new Error(text(msg("transfer.choose_files")));
        }
        names.forEach(filename);
        start = crypto.randomUUID();
      } catch (error) {
        sendMessage(String(error), "error");
      }
    }
    if (event.action === "transferred" || event.action === "transfer-failed") {
      done = true;
      model.data.result = [
        event.action === "transferred"
          ? text(msg("transfer.complete"))
          : String(event.value ?? model.data.result),
        ...paths,
      ].join("\n");
    }
  }
}
