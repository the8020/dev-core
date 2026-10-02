Parent DOX: [dev-core DOX](../AGENTS.md).

# Purpose

- Expose development sandbox administration and activation programs.

# Ownership

- Own ordinary command entrypoints and manifests; the development-test child
  owns the interactive console and activation screens.
- `code-browser/` owns read-only navigation through the current developer's
  package files, using the existing UUI list and code editor.

# Local Contracts

- Command programs are hidden, receive raw strings, and use typed kernel
  development operations through `../src/commands.ts`.
- Keep Git, private overlay state, sandbox lifecycle, and activation
  implementation in the kernel.

# Work Guidance

# Verification

- Run `deno task check` and `deno task test` from the repository root; kernel
  development tests cover activation and sandbox behavior.

# Child DOX Index

- [code-browser/AGENTS.md](code-browser/AGENTS.md): Read-only IDE-like source
  navigation, source identity, language queries and browser assets.
- [development-test/AGENTS.md](development-test/AGENTS.md): Present the
  authenticated user's development sandbox, console, and activation workflow.
