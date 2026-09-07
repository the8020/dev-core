Parent DOX: [dev-core DOX](../AGENTS.md).

# Purpose

- Expose the package-owned retained terminal workflow.

# Ownership

- Own service declarations and thin entrypoints. The sibling terminals scope
  owns implementation; the kernel owns physical PTYs and generic transport.

# Local Contracts

- Terminal service admission uses the existing authenticated access policy.
- Use explicit-completion session lifetime (`session_keep_alive = "0s"`).
  Retained handlers survive transport loss; closing a terminal completes its
  display owner. Ordinary list/metadata requests release their temporary
  binding.
- Multiple logical terminal owners share a Worker. No tmux or extra SSH process
  is involved, and no terminal is expired for being idle.
- The terminal entrypoint composes its database metadata store with the sibling
  service implementation. Creation runs on the service's node, which must own
  the requested sandbox. Existing-owner HTTP and WebSocket attachment use the
  exact signed route across nodes. Explicit close can reach the recorded
  physical node after its display Worker disappears.

# Work Guidance

# Verification

- Run the package check and terminal service tests. These include invalid-path
  and validation cleanup so temporary zero-keepalive bindings cannot leak.
- `test:native-resilience` checks real cross-node attachment and explicit
  cleanup after display-Worker loss; its fixture belongs to `terminals/`.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
