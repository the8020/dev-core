import { kernel } from "@the8020/kernel";
import {
  BACK_EVENT,
  callScreen,
  codeEditor,
  type CodeLineMarker,
  field,
  Model,
  presentPage,
  sendMessage,
  z,
} from "/p/the8020/uui/mod.ts";
import { activationFileInfo } from "../../src/fields.ts";

export interface ActivationPackagePreview {
  package_id: string;
  change: string;
  changed_files: number;
  added_rows: number;
  removed_rows: number;
  activation_ready: boolean;
  files: {
    path: string;
    change: string;
    diff?: { text: string; notice?: string };
  }[];
}

export function changeLabel(change: string): string {
  if (change === "added") return "[[icon=add color=success]] Added";
  if (change === "deleted") return "[[icon=remove color=error]] Deleted";
  return "[[icon=edit]] Modified";
}

async function previewPackage(user: string, id: string, file?: string) {
  const preview = await kernel.development.activate.preview({
    user_id: user,
    packages: id,
    ...(file === undefined ? {} : { file }),
  }) as { packages: ActivationPackagePreview[] };
  return preview.packages.find((item) => item.package_id === id);
}

export async function reviewPackageChanges(
  user: string,
  preview: ActivationPackagePreview,
): Promise<void> {
  const id = preview.package_id;
  let files = preview.files;
  const model = new Model({ files: [] as { path: string; change: string }[] });
  const schema = z.object({
    files: field(
      z.array(activationFileInfo.pick({ path: true, change: true })),
      {
        label: "Changed files",
        control: "list",
        readOnly: true,
      },
    ),
  });
  while (true) {
    model.data.files = files.map((file) => ({
      path: file.path,
      change: changeLabel(file.change),
    }));
    const event = await callScreen({
      id: "development-package-changes",
      title: `Changes in ${id}`,
      description: files.length
        ? "Choose a file to review its changes."
        : "No private file changes remain in this package.",
      schema,
      model,
      layout: {
        schema: 1,
        id: "development-package-changes",
        root: {
          id: "changed-files",
          type: "list",
          bind: "files",
          key: "path",
          display: ["change", "path"],
          columnOptions: { change: { length: "short" } },
        },
      },
      header: { actions: [{ id: "refresh", label: "Refresh" }] },
    });
    if (event.action === BACK_EVENT) return;
    try {
      if (event.action === "refresh") {
        files = (await previewPackage(user, id))?.files ?? [];
      }
      if (event.action === "select") {
        const selected = files.find((file) => file.path === event.value);
        if (selected) {
          await presentPage(() => reviewFileChange(user, id, selected.path));
        }
      }
    } catch (error) {
      sendMessage(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  }
}

async function reviewFileChange(user: string, id: string, path: string) {
  const model = new Model({ content: "" });
  let refresh = true;
  let notice = "";
  while (true) {
    if (refresh) {
      const preview = await previewPackage(user, id, path);
      const file = preview?.files.find((file) => file.path === path);
      if (file && !file.diff) throw new Error("The file diff is unavailable.");
      model.data.content = file?.diff?.text ?? "";
      notice = file
        ? file.diff?.notice ?? ""
        : "This file no longer has private changes. Refresh the changed-file list.";
      refresh = false;
    }
    // ponytail: UUI accepts 256 annotations; literal +/- remain visible after
    // that. Add range markers only when large diffs need more highlighting.
    const markers = model.data.content.split("\n").flatMap<CodeLineMarker>(
      (line, index) => {
        const kind = line.startsWith("+")
          ? "added"
          : line.startsWith("-")
          ? "removed"
          : undefined;
        return kind
          ? [{ line: index + 1, kind, label: kind === "added" ? "+" : "−" }]
          : [];
      },
    ).slice(0, 256);
    const event = await callScreen({
      id: "development-file-change",
      title: path,
      description: notice ? `${id}. ${notice}` : id,
      schema: z.object({
        content: field(activationFileInfo.shape.diff, {
          custom: codeEditor({ language: "text", syntaxCheck: false, markers }),
          readOnly: true,
          length: "long",
          rowSpan: 8,
        }),
      }),
      model,
      header: { actions: [{ id: "refresh", label: "Refresh" }] },
    });
    if (event.action === BACK_EVENT) return;
    if (event.action === "refresh") refresh = true;
  }
}
