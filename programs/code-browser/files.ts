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
  notice: string;
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
    throw new Error("This dependency is outside the browsable workspace.");
  }
  const path = decodeURIComponent(url.pathname);
  if (path.startsWith("/workspace/packages/")) return path.slice(20);
  if (path.startsWith("/opt/runtime/")) return "@runtime/" + path.slice(13);
  throw new Error("This dependency is outside Packages and the runtime SDK.");
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
    throw new Error("Enter 1–1,000 characters to search.");
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
    notice: `${
      limited ? "Partial results; narrow your search. " : ""
    }${rows.length} ${
      text ? "matching lines" : "files"
    }. Generated, hidden and vendor files are excluded.${
      skipped ? ` ${skipped} binary or large files skipped.` : ""
    }`,
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
  ) throw new Error("Choose a path inside Packages.");
  let target = await Deno.realPath(root);
  for (const part of parts) {
    target += "/" + part;
    if ((await Deno.lstat(target)).isSymlink) {
      throw new Error("Symbolic links cannot be opened in the code browser.");
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
        throw new Error(
          "This folder has more than 1,000 entries. Use the terminal to browse it.",
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
  if (!stat.isFile) throw new Error("Choose an ordinary source file.");
  if (stat.size > MAX_BYTES) {
    return {
      path,
      notice: "This file exceeds 128 KiB. Open it in the terminal.",
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
      notice: "This file exceeds 128 KiB. Open it in the terminal.",
    };
  }
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, size),
    );
    if (content.includes("\0")) throw new Error("binary");
    return { path, content };
  } catch {
    return { path, notice: "This file is binary or is not UTF-8 text." };
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
      }),
    );
    Deno.exit(1);
  }
}
