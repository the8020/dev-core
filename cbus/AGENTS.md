Parent DOX: [dev-core DOX](../AGENTS.md).

# Purpose

- Declare the public `dev-core.*` administrative commands.

# Ownership

- Own the flat `commands/*.toml` declarations; the repository root owns package
  identity and `programs/` owns execution.

# Local Contracts

- Each declaration supplies the complete public name in `command` and references
  an ordinary same-package program in `program`.
- Keep declarations flat. Filenames do not define command identity, and
  duplicate public names are invalid.

# Work Guidance

- Keep command behavior in the owning program or shared implementation.

# Verification

- Kernel CBus discovery and package tests cover declaration validation; use
  `go test ./kernel/cbus/... ./kernel/packages/...` from the sibling kernel
  repository with its local Go environment.
- Run this package's `deno task check` for the referenced program sources.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
