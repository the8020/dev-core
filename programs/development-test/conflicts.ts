import { text as localizedText } from "/p/the8020/i18n/mod.ts";
import { msg } from "/p/the8020/dev-core/i18n/messages.ts";
import { development } from "../../src/development.ts";
import {
  BACK_EVENT,
  callScreen,
  codeEditor,
  confirmAction,
  field,
  Model,
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
  const result = await development.sandbox.run("shell", user, {
    command:
      `printf %s '${data}' | base64 -d | deno run --no-config --allow-read --allow-write --allow-run=/usr/bin/git --allow-env=DEVELOPMENT_USER_ID /workspace/scripts/activation-conflicts.ts`,
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
      label = localizedText(msg("conflicts.yours"));
    } else if (line.startsWith("|||||||")) {
      side = "removed";
      label = localizedText(msg("conflicts.original"));
    } else if (line === "=======") {
      side = "added";
      label = localizedText(msg("conflicts.shared"));
    } else if (line.startsWith(">>>>>>>")) {
      side = undefined;
      return [{
        line: index + 1,
        kind: "error" as const,
        label: localizedText(msg("conflicts.end")),
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
  let status = localizedText(
    msg("conflicts.choose_a_file_resolve_the_marked_sections"),
  );
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
        {
          label: msg("conflicts.conflicting_files"),
          control: "list",
          readOnly: true,
        },
      ),
      content: field(conflictInfo.shape.content, {
        label: selected?.path ?? localizedText(msg("conflicts.resolution")),
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
        label: msg("conflicts.original"),
        custom: codeEditor({ language, syntaxCheck: false }),
        readOnly: true,
        rowSpan: 5,
        length: "long",
      }),
      private: field(conflictInfo.shape.content, {
        label: msg("conflicts.your_version"),
        custom: codeEditor({ language, syntaxCheck: false }),
        readOnly: true,
        rowSpan: 5,
        length: "long",
      }),
      shared: field(conflictInfo.shape.content, {
        label: msg("conflicts.shared_version"),
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
      ? localizedText(
        msg("conflicts.all_conflicts_resolved_continue_to_finish_activation"),
      )
      : file?.binary
      ? localizedText(msg("conflicts.binary_linked_or_large_file_choose_a"))
      : status;
    const event = await callScreen({
      id: "development-conflicts",
      title: msg("conflicts.resolve_activation_conflicts"),
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
              toolbar: [
                ...(files.length === 0
                  ? [{
                    id: "continue",
                    label: msg("conflicts.continue_activation"),
                    kind: "primary" as const,
                  }]
                  : [
                    ...(file?.hasPrivate
                      ? [{
                        id: "private",
                        label: msg("conflicts.use_your_version"),
                      }]
                      : []),
                    ...(file?.hasShared
                      ? [{
                        id: "shared",
                        label: msg("conflicts.use_shared_version"),
                      }]
                      : []),
                    {
                      id: "delete",
                      label: msg("conflicts.delete_file"),
                      kind: "danger" as const,
                    },
                  ]),
                { id: "refresh", label: msg("conflicts.refresh_from_git") },
              ],
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
                title: msg(
                  "conflicts.versions_for_comparison_an_absent_version_is",
                ),
                controls: ["private", "original", "shared"],
              }]
              : []),
          ],
        },
      },
      header: {
        actions: files.length > 0 && !file?.binary
          ? [{
            id: "save",
            label: msg("conflicts.save_resolution"),
            kind: "primary",
          }]
          : [],
      },
    });
    if (event.action === BACK_EVENT) return false;
    if (event.action === "change") continue;
    if (event.action === "select" || event.action === "refresh") {
      if (file && model.data.content !== file.content) {
        const discard = await confirmAction({
          id: "conflict-discard-draft",
          title: msg("conflicts.discard_unsaved_edits"),
          message: localizedText(
            msg("conflicts.your_unsaved_editor_changes_will_be_discarded"),
          ),
          confirm: msg("conflicts.discard_edits"),
          cancel: msg("conflicts.keep_editing"),
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
        status = localizedText(
          msg("conflicts.resolution_saved_choose_the_next_conflict"),
        );
        refresh = true;
      }
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      sendMessage(status, "error");
    }
  }
}
