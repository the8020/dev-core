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

## SSH regression qualification — 2026-09-10

The OpenSSH fixture uses the same disposable native harness, with an 80×24
headless client. It includes client parsing and, for named terminals, canonical
interpretation and VT projection. It excludes GUI painting and WAN latency. Run
with `--fixture=../dev-core/terminals/native_ssh_performance_scenarios.ts` and
the ordinary native harness options.
[Raw results](native-ssh-performance-results.json) compare the 0.6.5 baseline
with the 0.6.7 corrections.

| Corrected SSH path                  | Ordinary SSH | Retained SSH |
| ----------------------------------- | -----------: | -----------: |
| Median throughput, three 2-MiB runs |  16.63 MiB/s |   1.69 MiB/s |
| Input/display median at 60 Hz       |      4.62 ms |      9.07 ms |
| Input/display 95th percentile       |      6.75 ms |     13.90 ms |
| Exact, ordered click pairs          |        40/40 |        40/40 |

Both 0.6.5 and uncorrected 0.6.6 disconnected during a 2-MiB burst. The history
buffer charged every character as three bytes: a normal 256-KiB native read
could falsely exceed the one-MiB projection budget. Counting encoded UTF-8 bytes
preserves that budget and lets the burst complete. Retained projection delivered
about 3.44 MB of VT for each 2-MiB source payload, so its throughput is not a
raw SSH byte-copy rate. The source throughput range was 1.68–1.72 MiB/s.

The smaller workload (`THE8020_TERMINAL_BENCHMARK_SMALL=1`) lets both releases
finish. With equal two-MiB warm-up followed by three 128-KiB bursts, retained
median throughput was 1.15 MiB/s in 0.6.5 and 1.26 MiB/s after correction.
Retained median click/display latency was 9.67 and 9.88 ms respectively. There
was no observed steady-state throughput regression in this workload. Initial
small-burst samples with only 128 KiB of warm-up varied considerably, especially
in xterm 6; those earlier samples are retained in the raw report too. These few
local samples are not a guarantee for cold starts or remote networks.

Click bytes were recorded at the physical PTY during 60-Hz synchronized redraws.
All coordinates, presses, and releases arrived once and in order. The largest
retained inter-click timing difference from the sent intervals was 0.36 ms. An
unfinished synchronized frame timed out; subsequent ordinary SSH output was
immediate, as checked separately from normal redraw latency.

Real Midnight Commander opened the File menu at each of its four letter cells on
both SSH paths. Clicking different rows 80 ms apart opened the second folder;
350-ms spacing only selected it. This reproduces MC's time-based double-click
handling without a lost or duplicated input event. These checks do not establish
Warp's pixel-to-cell mouse mapping or rendering performance.

## Extended latency comparison — 2026-09-10

**A redraw scheduling regression is reproducible in 0.6.8.** Ordinary output
throughput and input latency remain similar to 0.6.5, but adjacent synchronized
frames cause repeated one-second pauses over retained SSH and continuous
rendering starvation in the browser. The earlier short, separated-frame tests
did not cover this case.

The comparison uses released dev-core commits `a6f9143` (0.6.5, xterm 5.5.0) and
`37638bf` (0.6.8, xterm 6.0.0), the same fixed kernel binaries and materialized
runtime image, real authenticated OpenSSH/gVisor sessions, and Chromium. Both
SSH clients use the same xterm 6 headless parser so changing the client parser
does not confound the server comparison. Browser runs use each release's actual
terminal component and renderer, with the existing public `Terminal.open` test
hook to observe `onWriteParsed` and `onRender`. Final measurements use 80×24
cells on both releases.

| Measurement                                              | 0.6.5 / xterm 5.5 |     0.6.8 / xterm 6 |
| -------------------------------------------------------- | ----------------: | ------------------: |
| Retained SSH throughput, median of 12 × 128 KiB          |        1.30 MiB/s |          1.27 MiB/s |
| SSH idle input/display median                            |          11.12 ms |            11.07 ms |
| SSH full-screen 60-Hz input/display median               |          10.15 ms |            10.03 ms |
| SSH full-screen 60-Hz input/display p95                  |          15.37 ms |            15.14 ms |
| SSH adjacent-frame input/display median                  |           9.16 ms |       **987.23 ms** |
| SSH adjacent-frame input/display maximum                 |          16.31 ms |     **1,008.68 ms** |
| Browser throughput through renderer, median of 3 × 2 MiB |        4.02 MiB/s |          4.13 MiB/s |
| Browser idle input/render median                         |            6.9 ms |              6.9 ms |
| Browser ordinary 60-Hz input/render median               |           13.5 ms |             13.7 ms |
| Browser adjacent-frame rendering over about 6.4 s        | 381 frame updates | **0 frame updates** |
| Browser adjacent-frame inputs received and parsed        |           200/200 |             200/200 |

SSH throughput warms up with two MiB before collecting the 12 samples; browser
throughput uses one two-MiB warm-up before three samples. SSH small bursts allow
both releases to complete; the older release's two-MiB native projection
overflow is documented above. Interactive tests normally collect 200 inputs per
workload. The SSH starvation case stops after 12 seconds, collecting 12 delayed
replies in 0.6.8 versus 200 ordinary replies in 0.6.5. Every input, including
mouse press/release coordinates, reached the physical PTY exactly once and in
order. Browser inputs are sent every 25 ms independently of rendering.

In the failing case, the application closes each completed frame and opens its
next frame in the same write (`CSI ? 2026 l`, then `CSI ? 2026 h`), at 60 Hz.
The workload is only a few kilobytes per second. The 0.6.8 producer's longest
frame interval was 20.54 ms, but SSH display updates were approximately 1,017 ms
apart. In the browser, all 200 acknowledgements were parsed with a 6.7-ms median
and 13.9-ms maximum, while rendering stayed frozen for the entire 6.39-second
observation. The same browser failure occurred in a separate run at the default
viewport size; 0.6.5 rendered normally in both runs.

`owner.ts` calls the native view once after applying a complete native batch.
`NativeTerminalView.update()` checks only the final synchronized-output mode.
When a completed frame and the next begin marker occur in that batch, the mode
is already active again and the view waits for its one-second deadline. In the
browser, xterm 6 checks the current mode again when the deferred render runs;
repeated end/begin transitions prevent the pending render from executing. See
the pinned upstream
[RenderService implementation](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/browser/services/RenderService.ts)
and
[synchronized-output contract](https://github.com/contour-terminal/vt-extensions/blob/master/synchronized-output.md).

The required repair is to preserve completed-frame boundaries and ensure pending
rendering can make progress when another frame immediately begins. Merely
increasing transport buffers or shortening the fallback timer would not repair
that contract. This investigation changes no runtime code and publishes no
release.

Limitations: this compares complete terminal implementations around the upgrade,
including the renderer and synchronization changes. The common kernel is a fixed
local build containing concurrent development changes, not a capture of the
deployed machine; its SHA-256 is recorded with the results. Runs are sequential
on a shared Linux arm64 host. Small throughput differences are not controlled
statistical claims. SSH excludes Warp's GPU rendering and WAN latency; browser
`onRender` measures renderer completion, not physical display scanout. The
synthetic case proves a regression but does not establish that every reported
live pause has this cause.

[Raw results](native-ssh-performance-results.json), under `extendedComparison`,
retain the SSH samples, browser results, versions, common binary fingerprints,
and local runner locations. Existing parent DOX contracts remain unchanged: this
adds measurements to the already-owned performance artifacts without changing
ownership or runtime behavior.
