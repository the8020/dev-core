# Purpose

- Provide the first-party 80|20 development workspace program and compact
  activation fixtures.
- This file is the root contract of the independent `the8020/dev-core` Git
  repository.

# Ownership

- Own `programs/development-test`, its sandbox lifecycle/console screen, and
  small `fixtures/activation-*` text and TypeScript fixtures.
- Do not own development workspace state, Git activation logic, sandbox
  implementation, browser console rendering, or services.

# Local Contracts

- The package root is its independent Git repository root.
- Source checks resolve sibling `kernel` and `uui` repositories; deployed
  Workers use only the canonical runtime `@the8020/*` and `@packages/*` aliases.
- Fixtures remain intentionally small and safe to edit, rename, delete, and
  restore through real development sandboxes.
- Development test lists only the authenticated user's workspace, derives its
  console target directly as `dev-<username>`, automatically creates or starts
  that sandbox on entry, delegates lifecycle operations to typed kernel
  commands, and provides only the declarative `sandbox-console.v1` descriptor
  with root's home and a standard administrative `PATH` to the UUI shell.
- Its destructive-reset guidance states that source reset preserves `/root` and
  system changes while factory reset deletes both.

# Work Guidance

- Keep examples readable as plain files so activation commits are easy to
  inspect.

# Verification

- Package-owned `deno task check` formats, lints, and type-checks the
  development program. Development-domain unit and real gVisor tests use
  `the8020/dev-core` and `the8020/demo` identities to prove independent
  histories and multi-package activation without pushing remotes; the browser
  E2E covers workspace lifecycle and the deterministic development console.

# Child DOX Index
