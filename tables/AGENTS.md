Parent DOX: [dev-core DOX](../AGENTS.md).

# Purpose

- Preserve bounded terminal names and exact display-owner references.

# Ownership

- Own authored table descriptors and the terminal metadata migration; the
  generic table evaluator owns schema deployment.

# Local Contracts

- `sessionId` is a sandbox-scoped name of 1–40 ASCII letters, digits, `_`, or
  `-`, unique with target kind and sandbox. `terminalId` identifies its current
  physical kernel-owned PTY. Execution references identify the distinct package
  display owner; target and execution sandbox IDs have different
  responsibilities.
- Never persist terminal contents, route tokens, or authentication credentials.
- Opening upserts the current physical identity and owner while preserving the
  session name and label. Rename changes only the label; explicit Close removes
  metadata. Physical expiry retains metadata so the session can open again.
- Existing table deployments run
  [terminals_session_id.sql](terminals_session_id.sql) once before updating the
  descriptor. It preserves rows using each old `terminalId` as its initial
  session name, then ordinary schema synchronization adds the unique index. The
  empty SQL default permits staged column addition; every service open supplies
  a validated nonempty ID. Fresh databases need no migration.

# Work Guidance

# Verification

- Run the package check and metadata/service tests.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
