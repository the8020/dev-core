# Native terminal measurements

These measurements use disposable gVisor sandboxes, real authentication and
service Workers, and Chromium on Linux arm64 with six available CPUs. Versions
are Go 1.26.5, Deno 2.9.4, runsc release-20260817.0, Chromium 151, and matching
xterm 5.5.0. [Raw samples](native-performance-results.json) include the exact
browser build and process counters.

Run `deno task bench:native-terminals` with the native harness options
documented in [AGENTS.md](AGENTS.md). The fixture creates eight consoles at
80×24, warms each transport, and sends a prebuilt two-MiB ASCII payload three
times through one console. The retained engine has at most 5,000 history rows.
Begin/end markers separate new output from earlier output still draining after a
detach. The browser counts bytes and parses recovery JSON; canvas painting is
excluded. CPU and RSS/PSS cover the fixture kernel and its descendant processes,
excluding Chromium and the test driver. These are local measurements, not a
network-speed or terminal-renderer benchmark.

| Operation                                           |      Direct console |     Retained terminal |
| --------------------------------------------------- | ------------------: | --------------------: |
| Median throughput                                   |          40.7 MiB/s |            11.8 MiB/s |
| Throughput range, three samples                     |     37.7–41.1 MiB/s |        6.7–13.1 MiB/s |
| Median CPU for two MiB                              |              0.05 s |                0.36 s |
| Median reconnect/reopen                             | 2.04 s, new process | 0.195 s, same process |
| Reconnect range, three samples                      |         1.99–2.26 s |         0.177–0.198 s |
| CPU during two seconds with eight idle consoles     |              0.12 s |                0.02 s |
| Marginal RSS per idle console, eight-console sample |            25.6 MiB |              32.8 MiB |
| Marginal PSS per idle console, eight-console sample |             2.3 MiB |               9.1 MiB |

RSS counts shared pages more than once; PSS apportions them. Both marginal
figures include runtime allocation and native exec overhead and are coarse:
shared runtime GC and background activity can dominate a short before/after
sample. The earlier run recorded a negative direct-console memory delta, so
these figures must not be treated as exact per-terminal heap sizes. CPU counters
have 10-ms resolution and exclude short-lived host processes that exit between
samples. Sustained-output figures include canonical parsing and scrollback in
the retained case.

Withholding browser credit detached the stalled view while the native producer
completed. Reattaching and sending another two MiB on the same process delivered
exactly the expected bytes. Three retained recoveries fetched and parsed a
5,161,776-byte uncompressed state snapshot in approximately 0.16–0.18 seconds;
the complete connection took the times above. Production browser recovery,
rendering and keyboard behavior have separate native/htop checks.

The initial retained implementation managed about 1.1 MiB/s. Replacing the SDK's
JavaScript Base64 iteration with native Uint8Array conversion removed allocation
work but did not materially improve that full-path result. The dominant delay
was awaiting a separate xterm timer turn for every small native read. Submitting
the already-bounded native batch to xterm's ordinary queue increased median
throughput about elevenfold and reduced median CPU from 1.07 to 0.36 seconds.
Per-event replies, resize ordering and atomic snapshot boundaries remain covered
by the engine and owner regressions. No synchronous parser bypass, additional
buffer window, idle expiry, or application-specific runtime transport was added.
