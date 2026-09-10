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
- [terminals/AGENTS.md](terminals/AGENTS.md): Own terminal browser rendering,
  display state, and package-owned terminal workflow.
- [public/AGENTS.md](public/AGENTS.md): Publish built browser modules and styles
  for on-demand loading by programs.
- [services/AGENTS.md](services/AGENTS.md): Declare the authenticated retained
  terminal service and its execution lifetime.
- [tables/AGENTS.md](tables/AGENTS.md): Store terminal names and exact owner
  references without terminal contents or routing credentials.

# Purpose

- Provide the first-party 80|20 development sandbox program and compact
  activation fixtures.
- This file is the root contract of the independent `the8020/dev-core` Git
  repository.

# Ownership

- `src/fields.ts` owns development sandbox and activation field definitions,
  shared labels, and help. Development sandbox IDs have no runtime-sandbox
  navigation. Sandbox states, activation readiness/change kinds, and conflict
  kinds offer known choices; last-operation and resolution messages remain
  unrestricted diagnostic text.

- Own `programs/development-test`, administrative development command programs,
  its sandbox lifecycle/console screen, terminal code and assets, and small
  `fixtures/activation-*` text and TypeScript fixtures.
- Do not own development sandbox state, Git activation logic, sandbox
  implementation, physical PTYs, generic browser hosting, or kernel routing.

# Local Contracts

- The package root is its independent Git repository root.
- Development declares `uui = true` for Home; command entrypoints keep the
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
- `dev-core.activate.run --defer-overlay-reset` carries the legacy helper option
  through the ordinary program/kernel call for baseline checks. Installed
  activation preserves the running sandbox and never requests that reset; UUI
  and CLI use the same activation owner.
- Development test selects the authenticated user's single sandbox by `user_id`,
  reads its opaque `sbx-` console target from the returned sandbox record,
  automatically creates or starts it on entry, delegates lifecycle operations to
  typed kernel commands, and supplies its own terminal module and stylesheet
  through UUI's generic custom-element wrapper. Terminal code, xterm
  dependencies, state recovery, and browser styling belong to this package. The
  retained client owns named-terminal controls and renders before the sandbox
  status fields. The group below the terminal owns sandbox identity, user help,
  state, restart, and resets; the subtitle uses the runtime username and UUI
  browser hostname for SSH guidance. Each reset requires its own confirmed
  modal: source reset preserves `/root` and system changes while factory reset
  deletes both.
- Terminal and development-sandbox idle deadlines belong to the kernel's
  existing owners and settings. The terminal service completes its retained
  handler when physical expiry is reported by the SDK. Keep session names and
  labels for connect-or-create; explicit Close removes metadata.
- Its activation screen previews every changed package with changed-file and
  added/removed-row counts plus ready/blocked state, requires one commit
  message, and invokes the typed user-scoped activation command to sync all
  ready changes at once. Package rows open changed filenames with
  edit/add/remove icons; selecting a file loads its read-only Git diff in the
  existing code editor. Returning preserves the draft message. It owns no Git or
  overlay implementation.
- Activation conflicts open the existing code editor with file selection,
  annotated versions, save/delete actions, and continuation. The kernel helper
  owns native Git operations; the UUI and sandbox terminal resolve the same
  retained attempt. Finish this prototype, including package deletions, before
  optimizing the filesystem or activation costs further.

- Development and activation screen loops retain UUI Model wrappers while
  refreshing business data. Activation uses full accessible count headings with
  compact short labels through shared list column metadata.

# Work Guidance

- Package development workflows and terminal components here, using ordinary
  programs, services, typed kernel calls, and generic UUI hosting. Keep
  unrelated features out of the shared shell and runtime.
- Keep workflow metadata, display-owner execution, physical PTYs, and sandbox
  lifetime distinct. Add kernel behavior only for a necessary native foundation
  gap, and verify that owner plus the affected development path.

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

- Package-owned `deno task check` formats, lints, and type-checks development
  programs, terminal service/table entrypoints, and the browser component.
  `deno task test` checks the terminal engine, owner, recovery bounds, and
  service protocol. `deno task test:browser` checks the real browser and
  retained protocol with deterministic native-terminal and authentication
  doubles; native SSH, deployment, and interactive programs require separate
  qualification. `test:native-browser` uses the sibling UUI node harness and
  disposable real gVisor terminals; required options are in the terminal DOX.
  `test:native-idle` checks real browser/SSH expiry and sandbox checkpoint/stop
  with seconds-long deadlines through the same disposable harness.
  `bench:native-terminals` uses that harness for direct/retained transport,
  recovery, slow-view, and process-tree resource measurements. The sibling UUI
  `test:programs-browser` checks the combined settings group, SSH subtitle,
  reset confirmation, activation validation, file/diff navigation, and console
  DOM preservation against deterministic kernel responses. Development-domain
  unit and real gVisor tests use `the8020/dev-core` and `the8020/demo`
  identities to prove independent histories and multi-package activation without
  pushing remotes; the browser E2E covers sandbox lifecycle, the registered
  development console, UUI activation validation/statistics, independent
  commits, and overlay reset.
