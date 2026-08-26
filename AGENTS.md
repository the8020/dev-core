# Purpose

- Provide the standard UUI session home and uncaught-program-termination
  programs.

# Ownership

- Own the compact program launcher, the Program terminated short-dump screen,
  exception inspection/source-context formatting, and the two default program
  manifests selected by global UUI settings.
- Do not own session transport, exception interception, kernel settings, browser
  rendering, authentication, or application programs.

# Local Contracts

- `core/uui/home` and `core/uui/program-terminated` are ordinary programs loaded
  through the same validated program loader as application programs.
- Both standard programs are hidden from normal program discovery.
- Home lists discoverable programs as clickable rows and invokes the selected
  program without injected dependencies or confirmation screens.
- Program terminated retains the original exception object for its screen
  lifetime and presents bounded type, message, custom properties, call stack,
  source context, and a copyable short dump.

# Work Guidance

- Keep Home minimal and keep exception inspection defensive against hostile
  getters, circular values, oversized values, unreadable source, and non-Error
  throws.

# Verification

- `src/short_dump_test.ts` covers Error and non-Error inspection, source
  location/context, circular custom values, and dump bounds; repository
  installation type-checks both programs.

# Child DOX Index
