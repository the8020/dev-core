Parent DOX: [dev-core/terminals DOX](../AGENTS.md).

# Purpose

- Render the package-owned terminal through UUI's generic custom-element host.

# Ownership

- Own xterm's DOM renderer, Fit addon, terminal styling, browser input/resize,
  and console transport. UUI owns only the wrapper and module lifecycle.

# Local Contracts

- `console.ts` default-exports the `CustomElementContext` mount contract. Build
  it independently; never import it into the UUI shell.
- Keep terminal CSS and dependency versions here. Use the matching headless
  version for retained display recovery.
- The pinned adapter in `state.ts` measures glyphs with fractional computed CSS
  widths, clears the width cache, and recalculates spacing. Measurement must
  remain independent of CSS transforms.
- Paint Unicode Block Elements U+2580–U+259F with exact cell geometry, retaining
  text for selection/copy and xterm's foreground/background, inverse, selection,
  and cursor styling. Keep private renderer access in `state.ts`. Block fixes
  must not change global fonts, line height, or scrollbar sizing; the ordinary
  terminal keeps `lineHeight: 1`.
- Use xterm's synchronized-output support to paint completed application frames.
  The pinned state adapter flushes the queued renderer on a parsed frame end,
  before a following begin marker can defer it again. Keep xterm's hidden-view
  handling and the matching upstream CSS, including viewport scrollbar styles.
- On resize, the pinned adapter keeps existing rows and scrollbar visible while
  parsing the redraw. Present at its explicit synchronized end, after 120 ms of
  quiet unmarked output, or after 300 ms without output. Late clear-scrollback
  and synchronized-begin markers can re-arm the hold within the same five-second
  resize deadline. Input, pointer/wheel interaction, disconnection, errors, and
  process exit release and disarm it; disposal clears its hooks and timers.
- Debounce geometry changes for 80 ms, retain one outstanding resize, and send
  the latest dimensions after acknowledgement. Resize the existing terminal.
- Open xterm in the detached component and prepare its styles before mounting.
  `state.ts` authorizes only xterm's generated styles with the shell's page
  nonce and applies RGB/selection styles through CSSOM; keep the shell CSP
  intact.
- Clicked terminal hyperlinks open directly in a new tab through xterm's public
  `linkHandler`, without a confirmation dialog. Keep its default HTTP/HTTPS
  protocol filtering and open with `noopener,noreferrer`.
- Encode Shift+Enter as `CSI 13;2u` through xterm's public input API and custom
  key handler so applications can distinguish it from Enter. Consume only that
  exact chord outside composition, once per keydown; other keys keep xterm's
  encoding. UUI shortcuts must not reinterpret consumed terminal keys. This is
  one explicit key mapping, not negotiated enhanced-keyboard mode support.
- The Development component uses the package's retained terminal service for
  create, list, select, rename, close, and explicit control takeover. Activity
  loss, navigation, reload, network loss, and disposal detach the view only.
- Keep terminal selection, New, Rename, Refresh, fullscreen, Close, and status
  in one toolbar, with status aligned right. These five buttons use accessible
  icon-only labels and tooltips through the host's `renderText` icon renderer.
- Close is red and last among the toolbar icons. Contain terminal scrolling so
  reaching either scroll boundary does not scroll the surrounding page.
- Fullscreen toggles UUI's generic `uui-content-fullscreen` class on the whole
  toolbar/terminal container. It fills the shell content below the global bar,
  resizes the existing terminal, and restores normal layout on toggle or page
  deactivation. Never use browser fullscreen or consume terminal Escape input.
- Restore the bounded snapshot and acknowledge its sequence before consuming
  later output. One display queue submits consecutive writes without waiting for
  each callback; metadata, resize, and restoration wait for pending writes
  across connections. Acknowledge output and release its queue budget only after
  parsing. Synchronize restored viewport geometry before rendering or scroll
  events; terminal selection must not reset over pending write callbacks.
- Handle bounded terminal error/control-denial notices immediately, before the
  display queue, and detach without replaying pending input. A following socket
  close must not discard the notice or its Take control action.
- Keep typing responsive over delayed connections with up to 64 input frames
  totaling 64 KiB in flight, sharing the limits in `protocol.ts` with the owner.
  Handle consumption acknowledgements before the display queue so a pending
  render cannot hold input credit. Bound total pending input to 1 MiB and 512
  frames, including sent frames. Reject oversized pastes before allocating or
  sending partial input; never replay input whose acknowledgement was lost.
- Allocate New IDs as the greatest existing all-numeric ID plus one, starting at
  `1`; ignore nonnumeric names. Render `[ID] Terminal ID` initially and
  `[ID] Label` after rename. IDs stay fixed and obey the kernel's 40-character
  alphanumeric/underscore/hyphen contract; allocation belongs only here.
- Entering the screen and reconnecting call `/open` for the selected session,
  even when its saved metadata or physical shell has disappeared. Authentication
  and validation failures stop recovery. Input/resize control stays exclusive.
- Retried HTTP failures keep their failure status visible alongside
  reconnecting; never replace a known HTTP error with a generic disconnection
  message.
- Re-entering the screen, terminal Refresh, and a changed program `refresh`
  revision reload the shared list and attempt ordinary control again. Switching
  terminals also attempts a fresh connection; previous control denial is not
  retained across attempts. Never take another client's control implicitly.
- Put Take control below the control-unavailable message in the terminal
  content, outside the toolbar. Hide it while connecting and after successful
  recovery.
- Show centered `Loading…` across the terminal content while listing, opening,
  and installing the initial display. Reveal xterm only when ready and keep its
  background stretched to the full viewport height.
- HTTP owner requests carry `the8020-route` in the header; only browser
  WebSocket establishment carries it in `?route=`. Follow the shared router's
  existing transport contract.

# Work Guidance

- Rebuild with `deno task build` after browser source or stylesheet changes.

# Verification

- Run the package check, `deno task test:browser`, and sibling UUI
  programs/browser tests. The package browser fixture exercises real Chromium
  and the retained service protocol with native-terminal doubles; native SSH,
  database/runtime deployment, and htop remain separate qualification gates.
- The browser test checks distinct Enter, Shift+Enter, and Alt+Enter bytes at
  the native-terminal boundary alongside Ctrl+A, Escape, and bracketed paste.
- It clicks OSC 8 links through the rendered terminal, checks direct HTTP/HTTPS
  opening without confirmation, and verifies that script URLs stay inactive.
- It holds input acknowledgements to verify the complete 64-frame window,
  ordered bytes and resumption; a blocked xterm write must not prevent more than
  one input window from reaching the native boundary. It also holds that write
  while a control-transfer notice and close arrive, verifying that Take control
  remains available.
- It holds actual xterm writes to check output pipelining, resize and reconnect
  barriers, and parse-based credit. Resize checks cover delayed/adjacent redraws
  beyond xterm's one-second timeout, stable scrollbars, unmarked/silent output,
  missing-end deadlines, and immediate release on input.
- It checks contiguous block columns across normal/bold text and spaces at
  multiple widths and pixel densities, including a transformed terminal. For
  Spynel qualification, launch in a fresh directory, keep the welcome screen
  open, and compare full-logo and shortened-viewport scrollbar screenshots.
- The native browser fixture checks actual indexed/RGB colors, cell spacing,
  cursor appearance, and CSP violations, including after snapshot restoration.
  Pixel equality alone cannot establish that either display rendered correctly.

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
