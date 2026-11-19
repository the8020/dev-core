import { DevelopmentError } from "../../i18n/errors.ts";
import type {
  CustomElementContext,
  CustomElementInstance,
} from "/p/the8020/uui/custom_element.ts";
import { t } from "../../i18n/browser.ts";
import {
  filename,
  header,
  MAX_FILE_BYTES,
  MAX_FILES,
} from "../transfer_protocol.ts";

export async function sendFiles(
  context: CustomElementContext,
  files: File[],
  progress: (value: string) => void,
): Promise<void> {
  if (!files.length || files.length > MAX_FILES) {
    throw new Error(t("transfer.choose_files"));
  }
  for (const file of files) {
    filename(file.name);
    if (file.size > MAX_FILE_BYTES) throw new Error(t("transfer.too_large"));
  }
  for (const file of files) {
    progress(file.name);
    const bytes = async function* () {
      yield header({ name: file.name, size: file.size });
      yield* file.stream();
    };
    await context.channel.send("upload", bytes(), { signal: context.signal })
      .done;
  }
}

export function uploadPicker(
  context: CustomElementContext,
): CustomElementInstance {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.setAttribute("aria-label", t("transfer.files"));
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  input.addEventListener("change", () => {
    context.setValue(
      Array.from(input.files ?? [], (file) => file.name).join("\n"),
    );
  });
  context.host.replaceChildren(input, status);
  let started: unknown;
  const update = (config: Record<string, unknown>) => {
    if (!config.start || config.start === started) return;
    started = config.start;
    input.disabled = true;
    queueMicrotask(async () => {
      try {
        await sendFiles(context, Array.from(input.files ?? []), (name) => {
          status.textContent = t("transfer.uploading", { name });
        });
        context.send("transferred");
      } catch (error) {
        if (!context.signal.aborted) {
          context.send(
            "transfer-failed",
            error instanceof DevelopmentError
              ? t(error.textKey)
              : String(error),
          );
        }
      }
    });
  };
  update(context.config);
  return { update };
}

export function droppedFiles(data: DataTransfer, clipboard = false): File[] {
  return Array.from(
    data.files,
    (file) =>
      clipboard && file.type.startsWith("image/") &&
        /^image\.[a-z0-9]+$/i.test(file.name)
        ? new File([file], `clipboard-${file.name}`, { type: file.type })
        : file,
  );
}
