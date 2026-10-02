import { context } from "@the8020/context";
import {
  BACK_EVENT,
  callScreen,
  codeEditor,
  type CodeLanguage,
  field,
  Model,
  packageAssetURL,
  presentModal,
  sendMessage,
  z,
} from "/p/the8020/uui/mod.ts";
import { development } from "../../src/development.ts";
import {
  type Entry,
  type Location,
  matchesExcerpt,
  readSource,
  type SearchResult,
  type Source,
  sourcePath,
  sourceText,
  sourceURI,
} from "./files.ts";
import { LanguageServer } from "./language.ts";
import assets from "./assets.json" with { type: "json" };
import type { ScreenElementState } from "/p/the8020/uui/protocol.ts";

const languages: Record<string, CodeLanguage> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  html: "html",
  css: "css",
  sql: "sql",
  py: "python",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  go: "go",
  sh: "shell",
  bash: "shell",
  toml: "toml",
};
const LocationInput = z.object({
  path: z.string().max(4096),
  line: z.number().int().positive().default(1),
  column: z.number().int().positive().default(1),
});
const OriginInput = LocationInput.extend({
  text: z.string().max(200000),
  firstLine: z.number().int().positive(),
});
const Input = LocationInput.partial().extend({
  origin: OriginInput.optional(),
});
const Row = z.object({
  id: z.string(),
  label: field(z.string(), { label: "Match" }),
  path: field(z.string(), { label: "File" }),
  line: field(z.number(), { label: "Line" }),
  column: z.number(),
});
type Row = z.infer<typeof Row>;
type Position = { line: number; character: number };
type Target = {
  uri?: string;
  targetUri?: string;
  range?: { start: Position };
  targetSelectionRange?: { start: Position };
};
type Symbol = {
  name: string;
  kind: number;
  selectionRange: { start: Position };
  children?: Symbol[];
};
type Sandbox = { user_id: string; state: string; sandbox_id: string };

async function workspace<T>(user: string, input: object): Promise<T> {
  const argument = `'${JSON.stringify(input).replaceAll("'", "'\\''")}'`;
  const result = await development.sandbox.run("shell", user, {
    command:
      `deno run --no-config --allow-read=/workspace/packages /workspace/packages/the8020/dev-core/programs/code-browser/files.ts ${argument}`,
  });
  const output = JSON.parse((result.shell as { output: string }).output);
  if (output.error) throw new Error(output.error);
  return output;
}

function rows(locations: Location[]): Row[] {
  return locations.slice(0, 200).map((location, index) => ({
    ...location,
    id: String(index),
  }));
}

function targets(value: unknown): Row[] {
  const locations: Location[] = [];
  for (
    const target
      of (Array.isArray(value) ? value : value ? [value] : []) as Target[]
  ) {
    const uri = target.targetUri ?? target.uri;
    const position = (target.targetSelectionRange ?? target.range)?.start;
    if (!uri || !position) continue;
    const path = sourcePath(uri);
    locations.push({
      path,
      line: position.line + 1,
      column: position.character + 1,
      label: path.split("/").at(-1)!,
    });
  }
  return rows(locations);
}

function outline(value: unknown, path: string): Row[] {
  const locations: Location[] = [];
  function visit(symbols: Symbol[], depth: number) {
    for (
      const symbol of symbols.toSorted((a, b) =>
        (a.selectionRange?.start.line ?? 0) -
        (b.selectionRange?.start.line ?? 0)
      )
    ) {
      if (locations.length >= 200) return;
      if (!symbol.selectionRange?.start) continue;
      if (depth === 0 || [5, 6, 9, 11, 12].includes(symbol.kind)) {
        locations.push({
          path,
          line: symbol.selectionRange.start.line + 1,
          column: symbol.selectionRange.start.character + 1,
          label: `${depth ? "↳ " : ""}${symbol.name}`,
        });
      }
      visit(symbol.children ?? [], depth + 1);
    }
  }
  visit(Array.isArray(value) ? value : [], 0);
  return rows(locations);
}

function hoverText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(hoverText).join("\n\n");
  if (value && typeof value === "object") {
    return hoverText(
      (value as { value?: unknown; contents?: unknown }).contents ??
        (value as { value?: unknown }).value,
    );
  }
  return "";
}

export default async function codeBrowser(raw: unknown = {}): Promise<void> {
  const input = Input.parse(raw);
  if (!context.authenticated) {
    throw new Error("An authenticated user is required.");
  }
  const user = context.username;
  let sandbox = (await development.sandbox.list() as Sandbox[]).find((item) =>
    item.user_id === user
  );
  if (!sandbox || !["READY", "BUSY", "CONFLICTED"].includes(sandbox.state)) {
    await development.sandbox.run(sandbox ? "start" : "create", user);
    sandbox = (await development.sandbox.list() as Sandbox[]).find((item) =>
      item.user_id === user
    );
  }
  if (!sandbox) throw new Error("Development sandbox is unavailable.");
  const sandboxId = sandbox.sandbox_id;
  let folder = "";
  let selected = "";
  let sourceNotice = "Choose a source file or use Quick open.";
  let crashLine: number | undefined;
  let resultsTitle = "Search";
  let searchNotice = "Search text across your package workspace.";
  let language: LanguageServer | undefined;
  let languageProject = "";
  let hover: { offset: number; text: string } | undefined;
  let jump: {
    revision: number;
    line: number;
    column: number;
    restore: boolean;
    state?: ScreenElementState;
  } = { revision: 0, line: 1, column: 1, restore: false };
  const documents = new Map<
    string,
    { source: Source; state?: ScreenElementState }
  >();
  const history: { path: string; state?: ScreenElementState }[] = [];
  let historyIndex = -1;
  const model = new Model({
    entries: [] as Entry[],
    results: [] as Row[],
    outline: [] as Row[],
    content: "",
    query: "",
  });
  const read = async (path: string): Promise<Source> =>
    path.startsWith("@runtime/")
      ? { ...await readSource("/opt/runtime", path.slice(9)), path }
      : await workspace<Source>(user, { path });
  const tab = (id: string) => {
    if (model.screen.elements.navigator?.selectedTab !== id) {
      remember();
      const elements = structuredClone(model.screen.elements);
      model.resetScreen();
      model.screen.elements = elements;
      jump = {
        ...jump,
        revision: jump.revision + 1,
        restore: true,
        state: elements["source-code"] ??
          { scroll: { x: 0, y: 0 }, toolbarOpen: false },
      };
    }
    model.screen.elements.navigator ??= {
      scroll: { x: 0, y: 0 },
      toolbarOpen: false,
    };
    model.screen.elements.navigator.selectedTab = id;
  };
  const remember = () => {
    if (!selected) return;
    const state = structuredClone(model.screen.elements["source-code"]);
    const document = documents.get(selected);
    if (document) document.state = state;
    if (history[historyIndex]) history[historyIndex]!.state = state;
  };
  async function engine(): Promise<LanguageServer> {
    const project = selected.startsWith("@runtime/")
      ? languageProject || "the8020/dev-core"
      : selected.split("/").slice(0, 2).join("/");
    if (language && languageProject !== project) {
      await language.close();
      language = undefined;
    }
    if (!language) {
      const packages: string[] = [];
      for (const namespace of (await read("")).entries ?? []) {
        if (namespace.kind !== "Folder") continue;
        for (const pkg of (await read(namespace.path)).entries ?? []) {
          if (pkg.kind === "Folder") packages.push(pkg.path);
        }
      }
      const candidate = new LanguageServer();
      await candidate.start(sandboxId, packages, project);
      language = candidate;
      languageProject = project;
    }
    return language;
  }
  const semantic = () =>
    /\.[cm]?[jt]sx?$/i.test(selected) && !!model.data.content;
  async function symbols() {
    model.data.outline = [];
    if (!semantic()) return;
    try {
      const server = await engine();
      const uri = sourceURI(selected);
      await server.open(uri, model.data.content);
      model.data.outline = outline(
        await server.request("textDocument/documentSymbol", {
          textDocument: { uri },
        }),
        selected,
      );
    } catch (error) {
      sendMessage(
        `Symbol navigation unavailable: ${
          error instanceof Error ? error.message : error
        }`,
        "warning",
      );
    }
  }
  async function open(
    path: string,
    location?: { line: number; column: number },
    navigation = true,
    refresh = false,
    restoreState?: ScreenElementState,
  ) {
    remember();
    let document = documents.get(path);
    if (!document || refresh) {
      const source = await read(path);
      if (source.entries) {
        folder = path;
        model.data.entries = source.entries;
        return;
      }
      if (!document && documents.size >= 20) {
        throw new Error(
          "Close an open file before opening another (20-file limit).",
        );
      }
      document = { ...document, source };
      documents.set(path, document);
    }
    if (restoreState) document.state = structuredClone(restoreState);
    selected = path;
    if (!path.startsWith("@runtime/")) {
      folder = path.split("/").slice(0, -1).join("/");
      model.data.entries = (await read(folder)).entries ?? [];
    }
    model.data.content = sourceText(document.source.content ?? "");
    sourceNotice = document.source.notice ??
      (path.startsWith("@runtime/")
        ? "Runtime SDK · read-only"
        : "Private workspace · read-only");
    crashLine = undefined;
    if (input.origin?.path === path) {
      const origin = input.origin;
      const matches = matchesExcerpt(model.data.content, origin);
      if (matches) crashLine = origin.line;
      sourceNotice += matches
        ? " · Matches the captured excerpt; crash revision was not recorded."
        : " · Differs from the captured excerpt. The original location may have moved; see Crash context.";
    }
    model.screen.elements["source-code"] = structuredClone(
      document.state ?? { scroll: { x: 0, y: 0 }, toolbarOpen: false },
    );
    jump = {
      revision: jump.revision + 1,
      line: location?.line ?? 1,
      column: location?.column ?? 1,
      restore: !location && !!document.state,
      state: structuredClone(
        document.state ?? { scroll: { x: 0, y: 0 }, toolbarOpen: false },
      ),
    };
    hover = undefined;
    if (navigation) {
      history.splice(historyIndex + 1);
      history.push({ path, state: document.state });
      if (history.length > 100) history.shift();
      historyIndex = history.length - 1;
    }
    await symbols();
  }
  model.data.entries = (await read(folder)).entries ?? [];
  try {
    if (input.path) {
      await open(input.path, {
        line: input.line ?? 1,
        column: input.column ?? 1,
      });
    }
    while (true) {
      const event = await callScreen({
        id: "code-browser",
        title: "Code browser",
        description: selected || "Your package workspace",
        model,
        schema: z.object({
          entries: field(
            z.array(
              z.object({
                path: z.string(),
                name: field(z.string(), { label: "Name" }),
                kind: field(z.string(), { label: "Kind" }),
              }),
            ),
            { label: "Files", control: "list", readOnly: true },
          ),
          results: field(z.array(Row), {
            label: resultsTitle,
            description: searchNotice,
            control: "list",
            readOnly: true,
          }),
          outline: field(z.array(Row), {
            label: "Outline",
            control: "list",
            readOnly: true,
          }),
          query: field(z.string().max(1000), {
            label: "Workspace text",
            enterEvent: "search",
            fieldHelp: false,
          }),
          content: field(z.string(), {
            label: selected.split("/").at(-1) || "Source",
            description: sourceNotice,
            readOnly: true,
            fieldHelp: false,
            length: "long",
            rowSpan: 7,
            custom: {
              ...codeEditor(),
              fallback: {
                outputs: [{
                  name: "value",
                  path: "",
                  label: "Source code",
                  multiline: true,
                }],
                actions: [
                  {
                    name: "definition",
                    label: "Go to definition",
                    event: "definition",
                  },
                  {
                    name: "references",
                    label: "Find references",
                    event: "references",
                  },
                  { name: "info", label: "Symbol information", event: "hover" },
                ],
              },
              module: packageAssetURL("the8020/dev-core", assets.module),
              styles: [
                ...codeEditor().styles!,
                ...assets.styles.map((path) =>
                  packageAssetURL("the8020/dev-core", path)
                ),
              ],
              config: {
                language:
                  languages[selected.split(".").at(-1)?.toLowerCase() ?? ""] ??
                    "text",
                syntaxCheck: false,
                markers: crashLine ? [{ line: crashLine, kind: "error" }] : [],
                path: selected,
                files: [...documents.keys()],
                semantic: semantic(),
                jump,
                hover: hover ?? null,
              },
            },
          }),
        }),
        controls: [{ id: "source-code", bind: "content" }],
        header: {
          actions: [
            {
              id: "quick-open",
              label: "[[icon=folder_open]] Quick open",
              shortcut: { key: "F9" },
            },
            ...(historyIndex > 0
              ? [{
                id: "navigate-back",
                label: "[[icon=arrow_back]] Previous location",
              }]
              : []),
            ...(historyIndex < history.length - 1
              ? [{
                id: "navigate-forward",
                label: "[[icon=arrow_forward]] Next location",
              }]
              : []),
            { id: "refresh", label: "[[icon=refresh]] Refresh" },
            ...(input.origin
              ? [{ id: "crash-context", label: "Crash context" }]
              : []),
          ],
        },
        layout: {
          schema: 1,
          id: "code-browser",
          root: {
            id: "browser",
            type: "split",
            ratio: [30, 70],
            responsive: "stack",
            children: [
              {
                id: "navigator",
                type: "tabs",
                children: [
                  {
                    id: "files-panel",
                    type: "list",
                    title: "Files",
                    bind: "entries",
                    key: "path",
                    display: ["name"],
                    toolbar: folder
                      ? [{ id: "up", label: "[[icon=arrow_upward]] Up" }]
                      : [],
                  },
                  {
                    id: "results-panel",
                    type: "list",
                    title: resultsTitle,
                    bind: "results",
                    key: "id",
                    display: ["label", "path", "line"],
                    toolbar: [{ id: "workspace-query", bind: "query" }, {
                      id: "search",
                      label: "[[icon=search]] Search",
                    }],
                  },
                  {
                    id: "outline-panel",
                    type: "list",
                    title: "Outline",
                    bind: "outline",
                    key: "id",
                    display: ["label", "line"],
                    columnOptions: {
                      label: { heading: "Symbol" },
                      line: { shortHeading: "Ln", length: "short" },
                    },
                  },
                ],
              },
              {
                id: "source",
                type: "field-group",
                title: "Source code",
                controls: ["source-code"],
              },
            ],
          },
        },
      });
      if (event.action === BACK_EVENT) return;
      if (event.action === "change") continue;
      try {
        if (event.action === "up") {
          await open(folder.split("/").slice(0, -1).join("/"));
        }
        if (event.action === "refresh") {
          if (language) await language.close();
          language = undefined;
          if (selected) await open(selected, undefined, false, true);
          model.data.entries = (await read(folder)).entries ?? [];
        }
        if (event.action === "select") {
          const value = "value" in event ? String(event.value) : "";
          const control = "controlId" in event ? event.controlId : "";
          if (control === "files-panel") {
            const entry = model.data.entries.find((item) =>
              item.path === value
            );
            if (entry) await open(entry.path);
          } else {
            const row = (control === "outline-panel"
              ? model.data.outline
              : model.data.results).find((item) =>
                item.id === value
              );
            if (row) await open(row.path, row);
          }
        }
        if (
          event.action === "open-file" && "value" in event &&
          documents.has(String(event.value))
        ) await open(String(event.value));
        if (
          event.action === "close-file" && "value" in event &&
          documents.has(String(event.value))
        ) {
          const path = String(event.value);
          remember();
          documents.delete(path);
          await language?.closeDocument(sourceURI(path));
          if (path === selected) {
            selected = "";
            const next = [...documents.keys()].at(-1);
            if (next) await open(next);
            else {
              model.data.content = "";
              model.data.outline = [];
              sourceNotice = "Choose a source file.";
              jump = {
                revision: jump.revision + 1,
                line: 1,
                column: 1,
                restore: false,
              };
            }
          }
        }
        if (["navigate-back", "navigate-forward"].includes(event.action)) {
          remember();
          const index = historyIndex +
            (event.action === "navigate-back" ? -1 : 1);
          const location = history[index];
          if (location) {
            await open(location.path, undefined, false, false, location.state);
            historyIndex = index;
          }
        }
        if (event.action === "quick-open") {
          const path = await presentModal(() => quickOpen(user));
          if (path) await open(path);
        }
        if (event.action === "workspace-search") tab("results-panel");
        if (event.action === "search") {
          const result = await workspace<SearchResult>(user, {
            search: model.data.query,
            text: true,
          });
          resultsTitle = "Search";
          searchNotice = result.notice;
          model.data.results = rows(result.rows);
          tab("results-panel");
          sendMessage(result.notice, "info");
        }
        if (
          ["definition", "references", "hover"].includes(event.action) &&
          semantic()
        ) {
          const saved = model.screen.elements["source-code"]?.data?.selection as
            | { head?: number }
            | undefined;
          const offset = "value" in event && typeof event.value === "number"
            ? event.value
            : saved?.head ?? 0;
          if (
            !Number.isSafeInteger(offset) || offset < 0 ||
            offset > model.data.content.length
          ) throw new Error("Choose a symbol in the current file.");
          const before = model.data.content.slice(0, offset).split("\n");
          const server = await engine();
          const result = await server.request(`textDocument/${event.action}`, {
            textDocument: { uri: sourceURI(selected) },
            position: {
              line: before.length - 1,
              character: before.at(-1)!.length,
            },
            ...(event.action === "references"
              ? { context: { includeDeclaration: true } }
              : {}),
          });
          if (event.action === "hover") {
            const text = hoverText(result).replace(
              /^```[^\n]*\n|^```\s*$/gm,
              "",
            );
            hover = {
              offset,
              text: (text.length > 12000
                ? `${
                  text.slice(0, 12000)
                }\n… More information is available at the definition.`
                : text) ||
                "No symbol information at this position.",
            };
          } else {
            const found = targets(result).map((row) => ({
              ...row,
              label: sourceText(documents.get(row.path)?.source.content ?? "")
                .split("\n")[row.line - 1]?.trim().slice(0, 200) || row.label,
            }));
            if (event.action === "definition" && found.length === 1) {
              await open(found[0]!.path, found[0]);
            } else {
              model.data.results = found;
              resultsTitle = event.action === "definition"
                ? "Definitions"
                : "References";
              searchNotice = `${found.length} ${resultsTitle.toLowerCase()}${
                found.length === 200 ? " (first 200)" : ""
              }.`;
              tab("results-panel");
              if (!found.length) {
                sendMessage(
                  "No matching symbols found. Unresolved dependencies may limit navigation.",
                  "info",
                );
              }
            }
          }
          if (server.warning) {
            sendMessage(server.warning, "warning");
            server.warning = "";
          }
        }
        if (event.action === "crash-context" && input.origin) {
          await presentModal(() => crashContext(input.origin!));
        }
      } catch (error) {
        sendMessage(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    }
  } finally {
    await language?.close();
  }
}

async function quickOpen(user: string): Promise<string | undefined> {
  const model = new Model({ query: "", matches: [] as Row[] });
  while (true) {
    const event = await callScreen({
      id: "quick-open",
      title: "Quick open",
      description: "Find a file by any part of its package path.",
      model,
      schema: z.object({
        query: field(z.string().max(1000), {
          label: "File name or path",
          fieldHelp: false,
          enterEvent: "find-file",
        }),
        matches: field(z.array(Row), {
          label: "Files",
          control: "list",
          readOnly: true,
        }),
      }),
      layout: {
        schema: 1,
        id: "quick-open",
        root: {
          id: "matches",
          type: "list",
          toolbar: [{ id: "file-query", bind: "query" }, {
            id: "find-file",
            label: "Find",
          }],
          bind: "matches",
          key: "id",
          display: ["path"],
        },
      },
    });
    if (event.action === BACK_EVENT) return;
    if (event.action === "find-file") {
      try {
        const found = await workspace<SearchResult>(user, {
          search: model.data.query,
        });
        model.data.matches = rows(found.rows);
        if (!found.rows.length || found.notice.startsWith("Partial results")) {
          sendMessage(found.notice, "info");
        }
      } catch (error) {
        sendMessage(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    }
    if (event.action === "select" && "value" in event) {
      const row = model.data.matches.find((item) => item.id === event.value);
      if (row) return row.path;
    }
  }
}

async function crashContext(
  origin: z.infer<typeof OriginInput>,
): Promise<void> {
  await callScreen({
    id: "crash-context",
    title: "Crash context",
    description:
      "Source excerpt captured when the error was displayed. The runtime did not record a commit revision.",
    model: new Model({ source: origin.text }),
    schema: z.object({
      source: field(z.string(), {
        label: origin.path,
        readOnly: true,
        length: "long",
        rowSpan: 6,
        fieldHelp: false,
        custom: codeEditor({
          language: "typescript",
          syntaxCheck: false,
          firstLine: origin.firstLine,
          revealLine: origin.line,
          markers: [{ line: origin.line, kind: "error" }],
        }),
      }),
    }),
  });
}
