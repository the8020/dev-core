import { kernel } from "@the8020/kernel";
import {
  BACK_EVENT,
  callScreen,
  codeEditor,
  field,
  Model,
  presentModal,
  sendMessage,
  z,
} from "/p/the8020/uui/mod.ts";
import { packageId } from "/p/the8020/packages/types/package.ts";
import { conflictInfo } from "../../src/fields.ts";

export interface ConflictPackage {
  package_id: string;
  conflict_worktree?: string;
}
interface ConflictFile {
  path: string;
  content: string;
  version: string;
  binary: boolean;
  original: string | null;
  private: string | null;
  shared: string | null;
  hasPrivate: boolean;
  hasShared: boolean;
}
interface FileRow {
  id: string;
  package: string;
  path: string;
  kind: string;
  worktree: string;
}

async function conflictCommand<T>(
  user: string,
  worktree: string,
  input: Record<string, unknown>,
): Promise<T> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ worktree, ...input }),
  );
  if (bytes.length > 64 * 1024) {
    throw new Error(
      "This edit is too large for this screen. Resolve it in the terminal.",
    );
  }
  const data = btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
  );
  const result = await kernel.development.sandbox.run("shell", user, {
    command:
      `printf %s '${data}' | base64 -d | deno run --allow-read --allow-write --allow-run=/usr/bin/git --allow-env=DEVELOPMENT_USER_ID /workspace/scripts/activation-conflicts.ts`,
  });
  return JSON.parse((result.shell as { output: string }).output) as T;
}

function markers(text: string) {
  let side: "added" | "removed" | "error" | undefined;
  // ponytail: cap annotations at UUI's 256-item limit; Git's text markers
  // remain visible beyond it. Add range annotations only if this limit matters.
  return text.split("\n").flatMap((line, index) => {
    let label: string | undefined;
    if (line.startsWith("<<<<<<<")) {
      side = "added";
      label = "Yours";
    } else if (line.startsWith("|||||||")) {
      side = "removed";
      label = "Original";
    } else if (line === "=======") {
      side = "added";
      label = "Shared";
    } else if (line.startsWith(">>>>>>>")) {
      side = undefined;
      return [{
        line: index + 1,
        kind: "error" as const,
        label: "End",
      }];
    }
    return side
      ? [{ line: index + 1, kind: side, ...(label ? { label } : {}) }]
      : [];
  }).slice(0, 256);
}

export async function resolveConflicts(
  user: string,
  packages: ConflictPackage[],
): Promise<boolean> {
  const worktrees = packages.filter((item) => item.conflict_worktree);
  let files: FileRow[] = [];
  let selected: FileRow | undefined;
  let file: ConflictFile | undefined;
  let refresh = true;
  let status =
    "Choose a file, resolve the marked sections, then save the resolution.";
  const model = new Model({
    files,
    content: "",
    original: "",
    private: "",
    shared: "",
    status,
  });
  while (true) {
    if (refresh) {
      files = [];
      for (const item of worktrees) {
        const result = await conflictCommand<
          { files: { path: string; kind: string }[] }
        >(user, item.conflict_worktree!, { action: "list" });
        files.push(
          ...result.files.map((entry) => ({
            ...entry,
            id: item.package_id + ":" + entry.path,
            package: item.package_id,
            worktree: item.conflict_worktree!,
          })),
        );
      }
      selected = files.find((row) => row.id === selected?.id) ?? files[0];
      file = selected
        ? await conflictCommand<ConflictFile>(user, selected.worktree, {
          action: "read",
          path: selected.path,
        })
        : undefined;
      model.data = {
        files,
        content: file?.content ?? "",
        original: file?.original ?? "",
        private: file?.private ?? "",
        shared: file?.shared ?? "",
        status,
      };
      refresh = false;
    }
    const language = selected?.path.endsWith(".ts")
      ? "typescript"
      : selected?.path.endsWith(".json")
      ? "json"
      : "text";
    const Schema = z.object({
      files: field(
        z.array(
          z.object({
            id: z.string(),
            package: packageId,
            path: conflictInfo.shape.path,
            kind: conflictInfo.shape.kind,
            worktree: z.string(),
          }),
        ),
        { label: "Conflicting files", control: "list", readOnly: true },
      ),
      content: field(conflictInfo.shape.content, {
        label: selected?.path ?? "Resolution",
        custom: codeEditor({
          language,
          syntaxCheck: false,
          markers: markers(model.data.content),
        }),
        rowSpan: 6,
        length: "long",
        readOnly: !file || file.binary,
      }),
      original: field(conflictInfo.shape.content, {
        label: "Original",
        custom: codeEditor({ language, syntaxCheck: false }),
        readOnly: true,
        rowSpan: 5,
        length: "long",
      }),
      private: field(conflictInfo.shape.content, {
        label: "Your version",
        custom: codeEditor({ language, syntaxCheck: false }),
        readOnly: true,
        rowSpan: 5,
        length: "long",
      }),
      shared: field(conflictInfo.shape.content, {
        label: "Shared version",
        custom: codeEditor({ language, syntaxCheck: false }),
        readOnly: true,
        rowSpan: 5,
        length: "long",
      }),
      status: field(conflictInfo.shape.status, {
        readOnly: true,
        length: "long",
      }),
    });
    model.data.status = files.length === 0
      ? "All conflicts resolved. Continue to finish activation."
      : file?.binary
      ? "Binary, linked, or large file. Choose a version, delete the file, or resolve it in the terminal."
      : status;
    const event = await callScreen({
      id: "development-conflicts",
      title: "Resolve activation conflicts",
      description: selected
        ? `${selected.package} / ${selected.path} — ${selected.kind}. ${model.data.status}`
        : model.data.status,
      schema: Schema,
      model,
      layout: {
        schema: 1,
        id: "development-conflicts",
        root: {
          id: "root",
          type: "stack",
          children: [
            {
              id: "files",
              type: "list",
              bind: "files",
              key: "id",
              display: ["package", "path", "kind"],
            },
            {
              id: "resolution",
              type: "field-group",
              controls: ["content"],
            },
            ...(file
              ? [{
                id: "versions",
                type: "field-group",
                title: "Versions for comparison (an absent version is blank)",
                controls: ["private", "original", "shared"],
              }]
              : []),
          ],
        },
      },
      header: {
        actions: [
          ...(files.length === 0
            ? [{
              id: "continue",
              label: "Continue activation",
              kind: "primary" as const,
            }]
            : [
              ...(!file?.binary
                ? [{
                  id: "save",
                  label: "Save resolution",
                  kind: "primary" as const,
                }]
                : []),
              ...(file?.hasPrivate
                ? [{ id: "private", label: "Use your version" }]
                : []),
              ...(file?.hasShared
                ? [{ id: "shared", label: "Use shared version" }]
                : []),
              { id: "delete", label: "Delete file", kind: "danger" as const },
            ]),
          { id: "refresh", label: "Refresh from Git" },
        ],
      },
    });
    if (event.action === BACK_EVENT) return false;
    if (event.action === "change") continue;
    if (event.action === "select" || event.action === "refresh") {
      if (file && model.data.content !== file.content) {
        const discard = await presentModal(async () => {
          const response = await callScreen({
            id: "conflict-discard-draft",
            title: "Discard unsaved edits?",
            description:
              "Your unsaved editor changes will be discarded. Saved Git resolutions are kept.",
            schema: z.object({}),
            model: new Model({}),
            header: {
              actions: [{
                id: "discard",
                label: "Discard edits",
                kind: "danger",
              }, { id: "keep", label: "Keep editing" }],
            },
          });
          return response.action === "discard";
        });
        if (!discard) continue;
      }
      if (event.action === "select") {
        selected = files.find((row) => row.id === event.value) ?? selected;
      }
      refresh = true;
      continue;
    }
    try {
      if (event.action === "continue") {
        for (const item of worktrees) {
          await conflictCommand(user, item.conflict_worktree!, {
            action: "finish",
          });
        }
        return true;
      }
      if (
        selected && file &&
        ["save", "private", "shared", "delete"].includes(event.action)
      ) {
        await conflictCommand(user, selected.worktree, {
          action: event.action,
          path: selected.path,
          content: model.data.content,
          version: file.version,
        });
        status = "Resolution saved. Choose the next conflict.";
        refresh = true;
      }
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      sendMessage(status, "error");
    }
  }
}
