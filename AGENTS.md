# Purpose

- Provide the first independent package repository used by development
  workspace isolation, draft, activation, selection, and conflict tests.

# Ownership

- Own this package's portable manifest and small text/TypeScript fixtures.
- Do not own development workspace state, Git activation logic, or services.

# Local Contracts

- The package root is its independent Git repository root.
- Fixtures remain intentionally small and safe to edit, rename, delete, and
  restore through real development sandboxes.

# Work Guidance

- Keep examples readable as plain files so activation commits are easy to
  inspect.

# Verification

- Development-domain unit and rootless E2E tests activate this package without
  changing the history of `example/development-b`.

# Child DOX Index
