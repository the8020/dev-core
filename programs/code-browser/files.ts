import { DevelopmentError } from "../../i18n/errors.ts";
export interface Entry {
  path: string;
  name: string;
  kind: string;
}

export interface Source {
  path: string;
  entries?: Entry[];
  content?: string;
  notice?: string;
}

export interface Location {
  path: string;
  line: number;
  column: number;
  label: string;
}

export interface SearchResult {
  rows: Location[];
  partial: boolean;
  skipped: number;
}

/** CodeMirror and LSP positions share UTF-16 offsets in this display text. */
export function sourceText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export function matchesExcerpt(
  content: string,
  origin: { firstLine: number; text: string },
): boolean {
  const excerpt = sourceText(origin.text);
  return origin.firstLine > 0 && sourceText(content).split("\n").slice(
        origin.firstLine - 1,
        origin.firstLine - 1 + excerpt.split("\n").length,
      ).join("\n") === excerpt;
}

export function sourceURI(path: string): string {
  path = path.split("/").map(encodeURIComponent).join("/").replace(
    /^%40runtime\//,
    "@runtime/",
  );
  return new URL(
    path.startsWith("@runtime/")
      ? `/opt/runtime/${path.slice(9)}`
      : `/workspace/packages/${path}`,
    "file://",
  ).href;
}

export function sourcePath(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== "file:" || url.host || url.search || url.hash) {
    throw new DevelopmentError(
      "errors.this_dependency_is_outside_the_browsable_workspace",
    );
  }
  const path = decodeURIComponent(url.pathname);
  if (path.startsWith("/workspace/packages/")) return path.slice(20);
  if (path.startsWith("/opt/runtime/")) return "@runtime/" + path.slice(13);
  throw new DevelopmentError(
    "errors.this_dependency_is_outside_packages_and_the_runtime_sdk",
  );
}

const MAX_BYTES = 128 * 1024;
const excluded = new Set([
  ".git",
  "node_modules",
  "vendor",
  ".generated",
  "public",
]);

/** A bounded, literal workspace search. Results always disclose incomplete scans. */
export async function searchSources(
  root: string,
  query: string,
  text: boolean,
): Promise<SearchResult> {
  if (!query.trim() || query.length > 1000) {
    throw new DevelopmentError("errors.enter_1_1_000_characters_to_search");
  }
  const rows: Location[] = [];
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let limited = false;
  const needle = query.toLowerCase();
  const expression = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "iu",
  );
  async function walk(folder: string): Promise<void> {
    for await (const entry of Deno.readDir(`${root}/${folder}`)) {
      if (
        excluded.has(entry.name) || entry.name.startsWith(".") ||
        entry.isSymlink
      ) continue;
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (limited) return;
      if (entry.isDirectory) {
        await walk(path);
      } else if (entry.isFile) {
        if (
          ++files > 10000 || bytes >= 32 * 1024 * 1024 || rows.length >= 200
        ) {
          limited = true;
          return;
        }
        if (!text) {
          if (path.toLowerCase().includes(needle)) {
            rows.push({
              path,
              line: 1,
              column: 1,
              label: path.split("/").at(-1)!,
            });
          }
          continue;
        }
        const source = await readSource(root, path);
        if (source.content === undefined) {
          skipped++;
          continue;
        }
        bytes += new TextEncoder().encode(source.content).length;
        const lines = sourceText(source.content).split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          const column = line.search(expression);
          if (column >= 0) {
            rows.push({
              path,
              line: i + 1,
              column: column + 1,
              label: line.trim().slice(0, 200),
            });
          }
          if (rows.length >= 200) {
            limited = true;
            return;
          }
        }
      }
    }
  }
  await walk("");
  return {
    rows,
    partial: limited,
    skipped,
  };
}

/** Read only ordinary files beneath the developer's package workspace. */
export async function readSource(root: string, path: string): Promise<Source> {
  const parts = path === "" ? [] : path.split("/");
  if (
    path.length > 4096 ||
    parts.some((part) => !part || [".", "..", ".git"].includes(part)) ||
    parts.slice(0, 2).some((part) => part.startsWith(".")) ||
    path.includes("\\") ||
    [...path].some((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  ) throw new DevelopmentError("errors.choose_a_path_inside_packages");
  let target = await Deno.realPath(root);
  for (const part of parts) {
    target += "/" + part;
    if ((await Deno.lstat(target)).isSymlink) {
      throw new DevelopmentError(
        "errors.symbolic_links_cannot_be_opened_in_the_code_browser",
      );
    }
  }
  const stat = await Deno.lstat(target);
  if (stat.isDirectory) {
    const entries: Entry[] = [];
    for await (const entry of Deno.readDir(target)) {
      if (entry.name === ".git" || entry.isSymlink) continue;
      if (parts.length < 2 && entry.name.startsWith(".")) continue;
      if (!entry.isFile && !entry.isDirectory) continue;
      if (entries.length >= 1000) {
        throw new DevelopmentError(
          "errors.this_folder_has_more_than_1_000_entries_use_the_terminal_to_browse_it",
        );
      }
      entries.push({
        path: [...parts, entry.name].join("/"),
        name: entry.name,
        kind: entry.isDirectory ? "Folder" : "File",
      });
    }
    entries.sort((a, b) =>
      Number(b.kind === "Folder") - Number(a.kind === "Folder") ||
      a.name.localeCompare(b.name)
    );
    return { path, entries };
  }
  if (!stat.isFile) {
    throw new DevelopmentError("errors.choose_an_ordinary_source_file");
  }
  if (stat.size > MAX_BYTES) {
    return {
      path,
      notice: "files.this_file_exceeds_128_kib_open_it",
    };
  }
  // Read one bounded buffer even if another process grows the file meanwhile.
  const file = await Deno.open(target, { read: true });
  const bytes = new Uint8Array(MAX_BYTES + 1);
  let size = 0;
  try {
    while (size < bytes.length) {
      const count = await file.read(bytes.subarray(size));
      if (count === null) break;
      size += count;
    }
  } finally {
    file.close();
  }
  if (size > MAX_BYTES) {
    return {
      path,
      notice: "files.this_file_exceeds_128_kib_open_it",
    };
  }
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, size),
    );
    if (content.includes("\0")) throw new Error("binary");
    return { path, content };
  } catch {
    return {
      path,
      notice: "files.this_file_is_binary_or_is_not",
    };
  }
}

if (import.meta.main) {
  try {
    const input = JSON.parse(Deno.args[0] ?? "{}");
    if (input.search !== undefined) {
      console.log(
        JSON.stringify(
          await searchSources(
            "/workspace/packages",
            input.search,
            input.text === true,
          ),
        ),
      );
    } else {
      const path = input.path ?? "";
      console.log(
        JSON.stringify(await readSource("/workspace/packages", path)),
      );
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        textKey: error instanceof DevelopmentError ? error.textKey : undefined,
      }),
    );
    Deno.exit(1);
  }
}
