Parent DOX: [dev-core DOX](../AGENTS.md).

# Purpose

- Own named-terminal metadata workflow and complete browser display recovery
  independently of UUI and authentication-session lifetime.

# Ownership

- Own the pinned xterm state component, headless display engine, and terminal
  workflow implementation. `service.ts` owns the authenticated HTTP/WebSocket
  protocol; `owner.ts` owns one canonical display processor and its controller.
  Kernel terminal operations own physical PTYs, ordered raw bytes, controller
  leases, and native process cleanup.
- `native_display.ts` projects the canonical engine's cells and input modes to
  VT for native SSH clients; `native_view.ts` owns its separate bounded send
  queue. Private xterm access stays in `state.ts`. No query or historical
  clipboard sequence is relayed to the SSH emulator.
- The frontend child owns browser rendering and controls. `build.ts` bundles its
  browser entrypoint into the package's public directory and writes the
  content-hashed `assets.json` manifest.

# Local Contracts

- Keep xterm browser and headless versions identical. State transfer preserves
  parser continuation, both buffers, modes, Unicode, links, palette, and cursor
  without replaying historical terminal output. Changes to private engine data
  require continuation and real-browser qualification.
- One canonical headless interpreter answers process queries, including while
  detached. Views never duplicate those responses. Historical snapshots never
  execute clipboard or notification effects.
- Submit the events in one bounded native read together to xterm's ordinary
  write queue. Preserve per-event query replies and flush preceding writes at
  every resize; publish the batch and snapshot boundary on the owner's ordered
  queue. Do not add a timer turn for every small PTY read or bypass xterm's
  parser scheduling with private synchronous writes.
- Bound native data windows, pending input, state, and view buffers. View loss
  detaches only; the kernel owns explicit and idle physical destruction. Report
  an absent display owner or lost output explicitly instead of claiming tail
  recovery.
- Names and owner references are bounded database metadata. Never store routing
  tokens, terminal contents, or authentication credentials there.
- Existing authenticated service admission applies to establishment and every
  reattachment. Terminal lifetime uses explicit-completion service bindings.
- Creation retains its handler independently of the establishing request, then
  publishes metadata and an exact signed route. Failure before acceptance closes
  the new PTY and removes its metadata. Later display-owner loss remains visible
  and never spawns a replacement under the old identity.
- HTTP list, rename, and close use independent temporary bindings. An unowned
  request, including validation failures and unknown paths, completes its
  binding. The service entrypoint supplies database storage; protocol tests use
  the same service with in-memory storage and a native-terminal double.
- If explicit close finds the recorded display Worker absent, it closes the
  physical terminal on its recorded node through the native SDK. Remove owned
  metadata only after that close succeeds. An unavailable node leaves metadata
  intact for a later explicit close; it never selects another process or node.
- Each browser view obtains exclusive input/resize control. The same client may
  replace its prior connection; a different client requires explicit takeover.
  Output send failure and view overflow close only that view. Native input
  acknowledgement means consumption; canonical query replies mean bounded
  admission so the interpreter can continue draining output.
- Snapshot capture and event sequencing share one ordered queue. HTTP delivers
  gzip JSON with a sequence boundary; the WebSocket queues only later events
  until the view acknowledges the snapshot. A view has a 256-KiB/64-frame send
  window and a 1-MiB/512-frame total queue. Lost native output fails recovery
  explicitly.
- Browser establishment first checks the exact owner's HTTP status so
  authentication and stale-owner failures remain distinguishable from transient
  transport loss. WebSocket heartbeats detect lost views; resize
  acknowledgements bound outstanding geometry changes. Neither expires the
  terminal.
- `snapshots.ts` permits two allocated recovery streams and 32 waiters per
  Worker. A snapshot is at most 64 MiB and retains its permit until consumed or
  cancelled. The two-minute recovery deadline applies only to that transfer,
  never to PTY lifetime.
- Native recovery shares those allocation permits and the 64-MiB limit. Live
  native display output is limited to one MiB/512 queued updates plus one
  in-flight update; writes are split into 64-KiB frames. A stalled frame has a
  ten-second transfer deadline, and initial recovery has a two-minute deadline.
  Overflow or transport failure releases only the view. Native clients recover
  normal history and current cells, then receive changed rows, committed
  history, cursor appearance, and keyboard/mouse modes.
- The kernel expires terminals with no browser/SSH attachments using
  `terminal.idle_timeout` (36 hours by default). This package supplies no
  timeout; its canonical processor does not extend terminal lifetime.
  `TerminalClosedError` ends the display handler normally, releases
  attachments/engine, and removes metadata through the existing service
  completion path.

# Work Guidance

- Keep workflow in this package and physical lifecycle in the shared kernel.
- Development uses the retained client. Preserve ordinary connection-bound
  console and SSH semantics. Phase 2 storage work remains separate and gated.

# Verification

- Use the existing package Deno check/test and Chromium harnesses. The earlier
  isolated serializer probes are component evidence, not completed application
  or interactive-program validation.
- Owner/service tests cover snapshot and later-output ordering, split UTF-8,
  detached queries, input acknowledgement, controller replacement, slow/broken
  views, request loss during creation, metadata isolation, and explicit cleanup.
  They use native-terminal doubles; actual browser, SSH, database deployment,
  and interactive-program qualification remain separate integration gates.
- `deno task test:browser` supplies `browser_scenarios.ts` to the sibling UUI
  presentation harness. It checks named controls, modified keys, Escape, Unicode
  bracketed paste and input bounds, scroll/selection, resize, immediate scroll
  after state restoration, navigation, reload, network loss, takeover between
  browser tabs, detached queries/output, fixture logout/login, exit, and close.
  It uses real Chromium and the service protocol with deterministic native PTYs
  and authentication; it does not establish native process or agent
  compatibility.
- `deno task test:native-browser` runs `native_browser_scenarios.ts` through the
  sibling UUI native harness with real users, database, service Workers, and
  gVisor PTYs. Pass its required `--source-root`, `--package-workspace`,
  `--runtime-root`, `--kernel`, `--admin`, and `--browser` options as
  `--name=value`. Use freshly built binaries and a materialized test runtime;
  the harness stages disposable package snapshots and nodes and never uses a
  developer sandbox. It checks native process identity through
  navigation/reload/logout, rendered snapshot recovery, detached queries,
  explicit controller transfer between tabs, and independent terminal cleanup.
  Offline query checks wait for native command admission and observe the result
  through an independent sandbox command before reconnecting. Use htop for
  interactive rendering, shortcuts, scrolling, resize, and reconnect checks; the
  user waived separate Codex/Claude interface tests. Full-system performance
  comparisons remain required.
- `deno task bench:native-terminals` uses the same native harness options to
  measure equal two-MiB payloads, eight idle consoles, three throughput/recovery
  samples, and withheld browser credit. It records a JSON report at
  `/tmp/8020-terminal-native-performance.json`, overridable through
  `THE8020_TERMINAL_BENCHMARK_REPORT`. The receiver counts bytes without canvas
  paint; retained recovery includes fetching and parsing the snapshot. CPU and
  RSS/PSS cover the disposable kernel's process tree, excluding Chromium and the
  driver. Treat marginal memory as a coarse observation: shared runtime GC and
  background cleanup affect it. Direct reconnect starts another process;
  retained reconnect preserves the process. Explicit begin/end markers separate
  each measured payload from output still draining after a disconnected view.
  [PERFORMANCE.md](PERFORMANCE.md) records the measured scope, samples and
  limitations;
  [native-performance-results.json](native-performance-results.json) contains
  the raw comparison.
- The native fixture uses OpenSSH with real password authentication to attach
  twice to the browser's running htop, checks function/search/scroll keys and
  query-free rendering, then returns to the browser with the same processes. It
  also checks one native query answer during SSH attachment and explicit browser
  takeover revoking SSH without changing the shell PID. Native display
  regressions also cover split parser/Unicode continuation, scrollback,
  alternate buffers, RGB, styled text, hyperlinks, and blocked-view isolation
  from canonical query processing.
- `test:native-resilience` uses the same disposable harness to check an exact
  terminal route through a second node, visible display-Worker loss, physical
  process survival, and explicit orphan close from the second node.
- `test:native-idle` uses an eight-second terminal deadline and two-second
  sandbox deadline to verify attached browser/SSH protection, repeated SSH
  reattachment, expiry despite output, metadata cleanup, subsequent sandbox
  stop, ordinary SSH lifetime, and restoration of private checkpointed files.

# Child DOX Index

- [frontend/AGENTS.md](frontend/AGENTS.md): Own terminal browser code and
  styles.

This parent owns the service, metadata access, headless engine, state component,
bounded recovery delivery, build, and tests.
