Parent DOX: [dev-core DOX](../AGENTS.md).

# Purpose

- Preserve bounded terminal names and exact display-owner references.

# Ownership

- Own authored table descriptors; the generic table evaluator owns deployment.

# Local Contracts

- Terminal IDs identify physical kernel-owned PTYs. Execution references
  identify the distinct package display owner; target and execution sandbox IDs
  have different responsibilities.
- Never persist terminal contents, route tokens, or authentication credentials.
- Creation inserts a new native identity. Rename preserves identity and owner;
  explicit close removes its metadata. Missing owners are reported, never
  replaced by approximate replay or a newly spawned process under the old ID.

# Work Guidance

# Verification

- Run the package check and metadata/service tests.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
