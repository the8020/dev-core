Parent DOX: [development programs](../AGENTS.md).

# Purpose

- Read and navigate the authenticated developer's package workspace. This is a
  navigation-first code browser, not a second editor, debugger, or deployment
  UI.

# Ownership

- `program.ts` owns files, quick open, text/symbol results, open documents and
  location history. `files.ts` reads bounded text and searches inside the
  sandbox.
- `language.ts` owns a program-lifetime Deno LSP process through native
  terminals; it closes the process when the program returns. No new network
  endpoint exists.
- `frontend.ts` extends the shared CodeMirror mount with navigation, literal
  highlighted search, hover information and open files. `build.ts` publishes
  hashed assets from these sources; `assets.json` selects the current build.

# Local Contracts

- Resolve identity from runtime context, gate sandbox work through development
  policy, and never accept a caller-supplied username or sandbox ID.
- Reads allow only ordinary, non-symlink files below `/workspace/packages`, plus
  the explicit `@runtime/` namespace from the running Worker's `/opt/runtime`.
  Reject traversal, Git internals and special files. Previews stop at 128 KiB;
  folders at 1,000 entries.
- Search is literal/case-insensitive and reports its bounds: 200 results, 10,000
  files or 32 MiB. Exclude hidden, generated, vendor, public and node_modules
  trees. Never describe a capped scan as exhaustive.
- Retain at most 20 open documents and 100 navigation locations. Store cursor,
  selection, scroll and find state per file through ordinary UUI element
  metadata. Explicit jumps use the shared editor's one-shot selection reveal;
  the editor alone owns scroll restoration, including initial mount.
- Language queries use Deno's actual package configs, `/p/` imports and runtime
  aliases, not textual approximations. Open the Worker's actual SDK sources as
  LSP documents so runtime aliases need no SDK installation or copied types in
  the private sandbox. Keep these documents open for the server lifetime.
  Missing external dependencies remain visible failures.
- Outline shows top-level declarations and nested callables in source order,
  rather than every object-literal property. Reference results reuse
  already-open source for context. Results are bounded to 200 locations.
- Normalize display line endings to LF before computing UTF-16 positions, so
  CRLF source and non-ASCII identifiers agree with the shared editor and LSP.
  Text search reports offsets in the original line, not a lowercased copy whose
  length can change for Unicode text.
- Exception input carries an excerpt, original line/column and path. Compare it
  with the private file and retain Crash context. A matching excerpt is not
  proof of a matching revision; the current exception contract records no commit
  hash.
- No source saves, rename/refactor requests, activation or remote writes.
- Agent fallback exposes read-only source and symbol actions. Agents may send a
  zero-based UTF-16 offset with `uui event definition --id source-code --json N`
  (or `references`/`hover`) after inspecting the source; omitted offsets use the
  last captured cursor.

# Work Guidance

- Keep 80|20 style an acceptance criterion, not a polishing pass: use native UUI
  cards, lists, tabs, fields, icons, theme tokens and focus behavior. Extend the
  shared editor and popover; do not invent a separate IDE palette or shell.
- Preserve native Tab/Escape and UUI F1–F4. Editor shortcuts are scoped to the
  component; every command also has a visible, labelled control.

# Verification

- Build with `deno task build:code-browser`; for sibling-source builds, set
  `DENO_IMPORT_MAP=deno.local.json` so the spawned bundle resolves local
  imports. Run package checks and
  `deno test --allow-read --allow-write programs/code-browser` with runtime SDK
  mappings, or the ordinary local import map when sibling kernel source exists.
- After dev-only activation, test exception → source → definition/references →
  another package → previous location, SDK aliases, quick open/search, read-only
  enforcement, cleanup and source mismatch. Check keyboard, desktop/mobile and
  light/dark appearance through the real authenticated shell.

# Child DOX Index

No child DOX documents.
