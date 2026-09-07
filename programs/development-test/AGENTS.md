Parent DOX: [dev-core/programs DOX](../AGENTS.md).

# Purpose

- Present the authenticated user's development sandbox, console, and activation
  workflow.

# Ownership

- Own the UUI program, manifest, console layout, and activation layout.

# Local Contracts

- Select the user's sandbox by username, read its `sbx-` ID from kernel state,
  and provide the package-owned terminal module and stylesheet using UUI's
  generic custom-element descriptor. UUI contains no terminal implementation.
- The package terminal component owns named-terminal controls and retained
  attachments independently of the screen. Leaving the screen detaches its view;
  the component's explicit Close action terminates the selected process.
- Activation previews all changed packages, requires a commit message, and
  invokes the typed user-scoped activation operation. Package rows open the
  public Packages program and preserve the draft message.
- Retain the UUI Model while refreshing sandbox and activation state; preserve
  the console across Advanced and activation pages. Keep the console and status
  prominent; Advanced owns user help, sandbox ID, SSH, restart, and resets.
- Confirm each reset in a dedicated modal describing its losses. Source reset
  preserves the root home directory and installed system changes; factory reset
  deletes both. Development sandbox IDs belong to the development manager and
  must not open the runtime Sandboxes program.

# Work Guidance

# Verification

- Run `deno task check` from the dev-core root.
- Run sibling UUI `deno task test:programs-browser` for reset confirmation,
  activation validation, package navigation, and console DOM preservation.
- Kernel development tests and the sibling UUI browser E2E cover sandbox
  lifecycle, activation validation, independent commits, and overlay reset.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
