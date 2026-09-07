Parent DOX: [dev-core DOX](../AGENTS.md).

# Purpose

- Publish this package's optional browser components and styles.

# Ownership

- Own generated browser artifacts. Authored terminal code lives in
  [terminals](../terminals/AGENTS.md).

# Local Contracts

- UUI's authenticated generic asset handler exposes this directory to browsers.
  Keep backend source, configuration, credentials, and private data outside it.
- `deno task build` produces content-hashed terminal files and updates
  `terminals/assets.json`. Programs reference that manifest through
  `packageAssetURL`; the shell bundle does not import these assets.
- Preserve dependency notices in the package's `THIRD_PARTY_NOTICES.md`.

# Work Guidance

- Rebuild authored source; do not edit generated JavaScript or styles here.

# Verification

- Run `deno task build` and the sibling UUI program/browser checks.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
