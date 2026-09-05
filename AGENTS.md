Parent DOX: [8020 workspace](../AGENTS.md).

Framework source:
[agent0ai/dox/AGENTS.md](https://github.com/agent0ai/dox/blob/765ae4ac02cc884eefcd41a3d0f71941721adb89/AGENTS.md).

# DOX framework

- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits

## Core Contract

- AGENTS.md files are binding work contracts for their subtrees
- Work products, source materials, instructions, records, assets, and durable
  docs must stay understandable from the nearest applicable AGENTS.md plus every
  parent AGENTS.md above it

## Read Before Editing

1. Read the root AGENTS.md
2. Identify every file or folder you expect to touch
3. Walk from the repository root to each target path
4. Read every AGENTS.md found along each route
5. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path,
   read that child and continue from there
6. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide
   rules
7. If docs conflict, the closer doc controls local work details, but no child
   doc may weaken DOX

Do not rely on memory. Re-read the applicable DOX chain in the current session
before editing.

## Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or
  quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child
index changes. Update child docs when parent changes alter local rules. Remove
stale or contradictory text immediately. Small edits that do not change behavior
or contracts may leave docs unchanged, but the DOX pass still must happen.

## Hierarchy

- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences,
  durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX
  Index
- Each parent explains what its direct children cover and what stays owned by
  the parent
- The closer a doc is to the work, the more specific and practical it must be

## Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its own
  purpose, rules, responsibilities, workflow, materials, or quality standards
- Work Guidance must reflect the current standards of the project or user
  instructions; if there are no specific standards or instructions yet, leave it
  empty
- Verification must reflect an existing check; if no verification framework
  exists yet, leave it empty and update it when one exists

Default section order:

- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

## Style

- Keep docs concise, current, and operational
- Document stable contracts, not diary entries
- Put broad rules in parent docs and concrete details in child docs
- Prefer direct bullets with explicit names
- Do not duplicate rules across many files unless each scope needs a local
  version
- Delete stale notes instead of explaining history
- Trim obvious statements, repeated rules, misplaced detail, and warnings for
  risks that no longer exist

## Closeout

1. Re-check changed paths against the DOX chain
2. Update nearest owning docs and any affected parents or children
3. Refresh every affected Child DOX Index
4. Remove stale or contradictory text
5. Run existing verification when relevant
6. Report any docs intentionally left unchanged and why

## User Preferences

When the user requests a durable behavior change, record it here or in the
relevant child AGENTS.md

## Child DOX Index

This root retains repository-wide contracts and files outside the child scopes
below.

- [cbus/AGENTS.md](cbus/AGENTS.md): Declare the public `dev-core.*`
  administrative commands.
- [fixtures/AGENTS.md](fixtures/AGENTS.md): Provide compact editable fixtures
  for independent package activation histories.
- [programs/AGENTS.md](programs/AGENTS.md): Expose development sandbox
  administration and activation programs.

# Purpose

- Provide the first-party 80|20 development sandbox program and compact
  activation fixtures.
- This file is the root contract of the independent `the8020/dev-core` Git
  repository.

# Ownership

- Own `programs/development-test`, administrative development command programs,
  its sandbox lifecycle/console screen, and small `fixtures/activation-*` text
  and TypeScript fixtures.
- Do not own development sandbox state, Git activation logic, sandbox
  implementation, browser console rendering, or services.

# Local Contracts

- The package root is its independent Git repository root.
- Development test declares `uui = true` for Home; command entrypoints keep the
  non-UUI default.
- Source checks resolve sibling `kernel` and `uui` repositories; deployed
  Workers use only the canonical runtime `@the8020/*` and `/p/*` aliases.
- Fixtures remain intentionally small and safe to edit, rename, delete, and
  restore through real development sandboxes.
- Flat `cbus/commands/*.toml` declarations use a required `command` field for
  the complete public name; filenames are arbitrary. They map visible
  `dev-core.*` commands to non-discoverable ordinary programs whose default
  exports parse raw string arguments, report intentional input errors
  structurally, and call typed kernel development operations.
- Development test selects the authenticated user's single sandbox by `user_id`,
  derives its console target directly as `dev-<username>`, automatically creates
  or starts it on entry, delegates lifecycle operations to typed kernel
  commands, and provides only the declarative `sandbox-console.v1` descriptor
  with root's home and a standard administrative `PATH` to the UUI shell. The
  untitled terminal renders before the sandbox status fields. Its description
  shows an SSH command for the authenticated username on localhost port 22 and
  warns that container, proxy, or published endpoint mappings may differ.
- Its destructive-reset guidance states that source reset preserves `/root` and
  system changes while factory reset deletes both.
- Its activation screen previews every changed package with changed-file and
  added/removed-row counts plus ready/blocked state, requires one commit
  message, and invokes the typed user-scoped activation command to sync all
  ready changes at once. It owns no Git or overlay implementation.

- Development and activation screen loops retain UUI Model wrappers while
  refreshing business data. Activation uses full accessible count headings with
  compact short labels through shared list column metadata.

# Work Guidance

- Keep examples readable as plain files so activation commits are easy to
  inspect.
- User-visible descriptions, hints, placeholders, notices, and empty-state copy
  must help the user act or understand a user-visible outcome. Never add copy
  solely to explain internal architecture, storage, persistence, sessions,
  transport, or implementation details; omit it entirely and keep those details
  in DOX or developer documentation. For example, never show
  `Value is stored per-session in the user storage.` or
  `The value is sent directly to kernel secret storage and is not shown again.`
  in the UI.

# Verification

- Package-owned `deno task check` formats, lints, and type-checks the
  development program. Development-domain unit and real gVisor tests use
  `the8020/dev-core` and `the8020/demo` identities to prove independent
  histories and multi-package activation without pushing remotes; the browser
  E2E covers sandbox lifecycle, the deterministic development console, UUI
  activation validation/statistics, independent commits, and overlay reset.
