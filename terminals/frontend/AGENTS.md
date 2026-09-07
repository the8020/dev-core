Parent DOX: [dev-core/terminals DOX](../AGENTS.md).

# Purpose

- Render the package-owned terminal through UUI's generic custom-element host.

# Ownership

- Own xterm, Canvas/Fit addons, terminal styling, browser input/resize, and
  console transport. UUI owns only the wrapper and module lifecycle.

# Local Contracts

- `console.ts` default-exports the `CustomElementContext` mount contract. Build
  it independently; never import it into the UUI shell.
- Keep terminal CSS and dependency versions here. Use the matching headless
  version for retained display recovery.
- The Development component uses the package's retained terminal service for
  create, list, select, rename, close, and explicit control takeover. Activity
  loss, navigation, reload, network loss, and disposal detach the view only.
- Keep terminal selection, New, Rename, Close, Refresh, fullscreen, and status
  in one toolbar, with status aligned right. These five buttons use accessible
  icon-only labels and tooltips through the host's `renderText` icon renderer.
- Fullscreen toggles UUI's generic `uui-content-fullscreen` class on the whole
  toolbar/terminal container. It fills the shell content below the global bar,
  resizes the existing terminal, and restores normal layout on toggle or page
  deactivation. Never use browser fullscreen or consume terminal Escape input.
- Restore the bounded snapshot and acknowledge its sequence before consuming
  later output. One display queue orders restoration, writes, and resize across
  connections. Synchronize restored viewport geometry before rendering or scroll
  events; terminal selection must not reset over pending write callbacks.
- Bound pending input to 1 MiB and 512 frames, with one 64-KiB frame in flight.
  Reject an oversized paste before allocating or sending partial input. Never
  replay input whose acknowledgement was lost.
- A view holds exclusive input and resize control. Authentication failures and
  absent owners stop recovery; reconnect never recreates an old terminal ID.
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

# Child DOX Index

No child DOX documents. This document owns the entire local scope.
