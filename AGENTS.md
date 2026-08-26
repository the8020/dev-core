# Purpose

- Provide the second independent package repository used by multi-package
  activation, per-package message, and partial-selection tests.

# Ownership

- Own this package's portable manifest and small text/TypeScript fixtures.
- Do not own development workspace state, Git activation logic, or services.

# Local Contracts

- The package root is its independent Git repository root and its history must
  remain independent from every sibling package.
- Fixtures remain intentionally small and safe to mutate in private overlays.

# Work Guidance

- Keep examples readable as plain files so activation commits are easy to
  inspect.

# Verification

- Development-domain unit and rootless E2E tests prove common and overridden
  commit messages plus partial package selection.

# Child DOX Index
