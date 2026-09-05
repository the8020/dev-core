Parent DOX: [dev-core/programs DOX](../AGENTS.md).

# Purpose

- Present the authenticated user's development sandbox, console, and activation
  workflow.

# Ownership

- Own the UUI program, manifest, and activation layout.

# Local Contracts

- Select the user's deterministic `dev-<username>` sandbox and pass only the
  declarative console descriptor to UUI.
- Activation previews all changed packages, requires a commit message, and
  invokes the typed user-scoped activation operation.
- Retain the UUI Model while refreshing sandbox and activation state; preserve
  the distinct source-reset and factory-reset guidance.

# Work Guidance

# Verification

- Run `deno task check` from the dev-core root.
- Kernel development tests and the sibling UUI browser E2E cover sandbox
  lifecycle, activation validation, independent commits, and overlay reset.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
