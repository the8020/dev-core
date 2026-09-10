Parent DOX: [dev-core/programs DOX](../AGENTS.md).

# Purpose

- Present the authenticated user's development sandbox, console, and activation
  workflow.

# Ownership

- Own the UUI program, manifest, console layout, and activation layout.

# Local Contracts

- Reuse package-owned development and activation fields from `src/fields.ts`;
  keep terminal controls, layout, and presentation hints in this program.

- Select the user's sandbox by username, read its `sbx-` ID from kernel state,
  and provide the package-owned terminal module and stylesheet using UUI's
  generic custom-element descriptor. UUI contains no terminal implementation.
- The package terminal component owns named-terminal controls and retained
  attachments independently of the screen. Leaving the screen detaches its view;
  the component's explicit Close action terminates the selected process.
- Page Refresh advances the terminal component's `refresh` revision so it
  reloads the shared session list and reconnects the selected terminal.
- Activation previews all changed packages, requires a commit message, and
  invokes the typed user-scoped activation operation. `changes.ts` opens a
  package's changed filenames with labelled edit/add/remove icons, then opens
  the selected file's read-only diff in `codeEditor()` with green additions and
  red removals. Back preserves the list and commit-message draft. Refresh reads
  current changes; file contents load only on file selection through the same
  preview operation with `packages` and `file`. The native owner supplies the
  per-path original comparison and explicit binary/large-file notices.
- Package rows also show added/modified/deleted state. Moves use matching
  deletion/addition rows and diffs. Do not repeat a +/- legend in the editor.
  Preview failures stay on activation with an actionable error and Refresh;
  preserve the commit-message draft and hide activation until preview succeeds.
- `conflicts.ts` presents the activation owner's retained Git worktrees using a
  file selector, `codeEditor()` line markers, and labelled
  original/private/shared versions. Save resolution, side selection, and
  deletion update that same native index through the sandbox shell and platform
  `activation-conflicts.ts` helper. Continue commits resolved indexes and
  retries ordinary activation.
- Reopening activation discovers pending conflicts through sandbox inspection.
  Terminal changes are picked up by Refresh from Git; stale saves fail without
  overwriting the terminal's file. Confirm discarding an unsaved editor draft
  before switching files or refreshing. Binary, linked, and files over 48 KiB
  use side selection/deletion or ordinary terminal Git.
- Retain the UUI Model while refreshing sandbox and activation state; preserve
  the console across activation pages. One field group below the terminal owns
  user help, sandbox ID, state, last operation, restart, and resets. There is no
  separate Advanced page.
- Read the authenticated username from `@the8020/context`. The page subtitle
  shows an SSH command using that username and the hostname from UUI's
  `currentBrowser().origin`, with SSH port 22, plus
  `ssh -t ... the8020
  terminal-id XYZ` for a specific persistent session.
  Browser metadata is presentation input, never user identity; quote
  shell-sensitive destination characters.
- Confirm each reset in a dedicated modal describing its losses. Source reset
  preserves the root home directory and installed system changes; factory reset
  deletes both. Development sandbox IDs belong to the development manager and
  must not open the runtime Sandboxes program.

# Work Guidance

# Verification

- Run `deno task check` from the dev-core root.
- Run sibling UUI `deno task test:programs-browser` for reset confirmation,
  activation validation, changed-file icons, lazy diff loading, added/modified/
  deleted/binary views, draft retention, and console DOM preservation.
- Kernel development tests and the sibling UUI browser E2E cover sandbox
  lifecycle, activation validation, independent commits, and overlay reset.
- `activation_processes.ts` uses the ordinary installer-built kernel through the
  existing native harness, including after relocating its binary directory. CLI
  activation and the UUI's command path preserve a running process's PID and
  start time. Startup refuses to ignore a legacy checkpoint with private work.
- `prototype_browser.ts` uses two development sandboxes to check live shared
  files, new packages, UUI conflict resolution, CLI takeover, continuation and
  deletion. It also checks retained private Git history after shared deletion
  and an explicit restart. Build and invocation are in kernel analysis
  `PROTOTYPE.md`.
- `prototype_concurrency.ts` uses the same disposable native harness separately
  from the UI scenario. It holds a real pre-activation hook, requires another
  package to publish while that hook waits, checks prompt overlap rejection and
  health availability, then resolves the retried overlap through ordinary Git.
  It writes the scoped `prototype-concurrency-results.json` in kernel analysis;
  the manual review instance and its pending conflicts remain untouched.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
