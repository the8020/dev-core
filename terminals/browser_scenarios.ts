import { assertEquals } from "@std/assert";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestMetadata, WebSocketSession } from "@the8020/http";
import type {
  kernel,
  PersistentServiceTarget,
  TerminalAttachment,
} from "@the8020/kernel";
import { installContextProvider } from "../../kernel/defaults/config/runtime/deno/context/runtime.ts";
import {
  callScreen,
  Model,
  packageAssetURL,
  presentPage,
  z,
} from "/p/the8020/uui/mod.ts";
import type { TerminalMetadataStore, TerminalRecord } from "./metadata.ts";
import { defineTerminalService, workerFunctions } from "./service.ts";
import { TERMINAL_PROTOCOL, TERMINAL_SERVICE } from "./protocol.ts";
import { TestSocket, TestTerminals } from "./test_support.ts";

interface Browser {
  evaluate<T>(expression: string): Promise<T>;
  command<T = Record<string, unknown>>(
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<T>;
  close(): void;
}

/** Actual UUI/Chromium and HTTP/WebSocket protocol; physical PTYs are deterministic doubles. */
export default async function fixture(temporaryRoot: string) {
  const published = `${temporaryRoot}/packages/the8020/dev-core/public`;
  await Deno.mkdir(published, { recursive: true });
  const browserEntry = `${temporaryRoot}/terminal-browser-fixture.ts`;
  await Deno.writeTextFile(
    browserEntry,
    `
    import { Terminal } from '@xterm/xterm';
    import mount from ${
      JSON.stringify(new URL("frontend/console.ts", import.meta.url).href)
    };
    import { captureTerminal, restoreTerminal } from ${
      JSON.stringify(new URL("state.ts", import.meta.url).href)
    };
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (...args) {
      globalThis.__terminalForTest = this;
      return open.apply(this, args);
    };
    globalThis.__testRestoreScroll = () => {
      const terminal = globalThis.__terminalForTest;
      restoreTerminal(terminal, captureTerminal(terminal));
      const viewport = terminal.element.querySelector('.xterm-viewport');
      // Deliver scroll before reset's next animation frame, including the
      // event following an internal scrollTop change.
      viewport.dispatchEvent(new Event('scroll'));
      viewport.dispatchEvent(new Event('scroll'));
      return Number.isInteger(terminal.buffer.active.viewportY);
    };
    export default mount;
  `,
  );
  const bundle = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--config",
      new URL("../deno.json", import.meta.url).pathname,
      "--platform",
      "browser",
      "--minify",
      "--output",
      `${published}/terminal.js`,
      browserEntry,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!bundle.success) {
    throw new Error("Retained terminal browser fixture build failed");
  }
  await Deno.copyFile(
    new URL("frontend/console.css", import.meta.url),
    `${published}/terminal.css`,
  );
  const contexts = new AsyncLocalStorage<RequestMetadata>();
  const releaseContext = installContextProvider(() => {
    const meta = contexts.getStore();
    return meta
      ? {
        type: "service",
        id: meta.execution.persistentExecutionId!,
        contextId: meta.contextId,
        ...meta.execution,
        ...meta.user,
        authenticated: meta.auth.authenticated,
      }
      : undefined;
  });
  const records = new Map<string, TerminalRecord>();
  const terminals = new Map<string, TestTerminals>();
  const nativeOwners = new Map<string, PersistentServiceTarget>();
  const firstList = Promise.withResolvers<void>();
  let loading = true;
  const attachments = new Map<string, TestTerminals>();
  const retained = new Set<string>();
  const lifetimes = new Set<Promise<void>>();
  const sockets = new Set<TestSocket>();
  let ordinal = 0;
  let attachmentOrdinal = 0;
  let bindingOrdinal = 0;
  let requestOrdinal = 0;
  let authenticated = true;
  let openError: string | undefined;
  let openAttempts = 0;
  const id = (prefix: string, n: number) =>
    `${prefix}-${String(n).padStart(10, "0")}`;
  const attach = (native: TestTerminals, inner: TerminalAttachment) => {
    const value = { ...inner, attachmentId: id("att", ++attachmentOrdinal) };
    attachments.set(value.attachmentId, native);
    return value;
  };
  const nativeAPI: typeof kernel.terminals = {
    open: async (input) => {
      openAttempts++;
      if (openError) throw new Error(openError);
      const existing = [...terminals.values()].find((native) =>
        native.native.terminal.sandboxId === input.sandboxId &&
        native.native.terminal.sessionId === input.sessionId &&
        !native.closed.length && !native.native.terminal.exited
      );
      if (existing) {
        return {
          terminal: existing.native.terminal,
          owner: nativeOwners.get(existing.native.terminal.id)!,
        };
      }
      const ended = [...terminals.values()].find((native) =>
        native.native.terminal.sandboxId === input.sandboxId &&
        native.native.terminal.sessionId === input.sessionId &&
        native.native.terminal.exited
      );
      if (ended && !ended.closed.length) {
        await ended.api.close(ended.native.terminal.id);
      }
      const native = await nativeAPI.create(input);
      native.terminal.sessionId = input.sessionId;
      nativeOwners.set(native.terminal.id, input.owner);
      return { ...native, after: 0, reset: false };
    },
    create: async (input) => {
      const native = new TestTerminals();
      native.native.terminal = {
        ...native.native.terminal,
        id: id("tty", ++ordinal),
        kind: input.kind,
        sandboxId: input.sandboxId,
        size: input.size,
      };
      terminals.set(native.native.terminal.id, native);
      const value = attach(native, await native.api.create(input));
      native.emit({
        data: new TextEncoder().encode(
          `\u001b[32mTerminal ${ordinal}\u001b[0m\r\n$ `,
        ),
      });
      return value;
    },
    list: () =>
      Promise.resolve(
        [...terminals.values()].map((native) => native.native.terminal),
      ),
    inspect: (terminal) =>
      Promise.resolve(terminals.get(terminal)!.native.terminal),
    attach: async (terminal, mode) => {
      const native = terminals.get(terminal)!;
      return attach(native, await native.api.attach(terminal, mode));
    },
    read: (attachment, after, signal) =>
      attachments.get(attachment)!.api.read(attachment, after, signal),
    nextView: (attachment, signal) =>
      attachments.get(attachment)!.api.nextView(attachment, signal),
    writeView: (attachment, view, data, signal) =>
      attachments.get(attachment)!.api.writeView(
        attachment,
        view,
        data,
        signal,
      ),
    finishView: (attachment, view, signal) =>
      attachments.get(attachment)!.api.finishView(attachment, view, signal),
    write: async (attachment, data, signal) => {
      const native = attachments.get(attachment)!;
      await native.api.write(attachment, data, signal);
      native.emit({ data });
    },
    respond: (attachment, data, signal) =>
      attachments.get(attachment)!.api.respond(attachment, data, signal),
    resize: (attachment, size, signal) =>
      attachments.get(attachment)!.api.resize(attachment, size, signal),
    detach: (attachment) => attachments.get(attachment)!.api.detach(attachment),
    close: (target) => {
      const terminal = typeof target === "string" ? target : target.terminalId;
      return terminals.get(terminal)!.api.close(target);
    },
  };
  const store: TerminalMetadataStore = {
    list: (user, kind, sandbox) =>
      Promise.resolve(
        [...records.values()].filter((record) =>
          record.authenticatedUserId === user && record.targetKind === kind &&
          record.targetSandboxId === sandbox
        ),
      ),
    find: async (user, kind, sandbox, sessionId) =>
      (await store.list(user, kind, sandbox)).find((record) =>
        record.sessionId === sessionId
      ),
    get: (user, terminal) => {
      const record = records.get(terminal);
      return Promise.resolve(
        record?.authenticatedUserId === user ? record : undefined,
      );
    },
    create: async (record) => {
      const previous = await store.find(
        record.authenticatedUserId,
        record.targetKind,
        record.targetSandboxId,
        record.sessionId,
      );
      if (previous) records.delete(previous.terminalId);
      records.set(record.terminalId, record);
      return Promise.resolve();
    },
    rename: (user, terminal, name) => {
      const record = records.get(terminal);
      if (record?.authenticatedUserId === user) record.name = name;
      return Promise.resolve();
    },
    remove: (user, terminal) => {
      if (records.get(terminal)?.authenticatedUserId === user) {
        records.delete(terminal);
      }
      return Promise.resolve();
    },
  };
  const service = defineTerminalService(store, {
    terminals: nativeAPI,
    runPersistent: (handler) => {
      const binding = contexts.getStore()!.execution.persistentExecutionId!;
      retained.add(binding);
      const lifetime = handler().finally(() => {
        retained.delete(binding);
        lifetimes.delete(lifetime);
      });
      lifetimes.add(lifetime);
      return lifetime;
    },
    completePersistent: () => {
      retained.delete(contexts.getStore()!.execution.persistentExecutionId!);
      return Promise.resolve();
    },
    route: (target) => Promise.resolve(target.persistentExecutionId),
    invoke: async <Result>(
      input: { function: string; input: unknown },
    ): Promise<Result> => {
      return await workerFunctions
        [input.function as keyof typeof workerFunctions](input.input) as Result;
    },
  });
  const metadata = (
    binding = id("pex", ++bindingOrdinal),
  ): RequestMetadata => ({
    contextId: id("ctx", ++requestOrdinal),
    serviceId: "the8020/dev-core/terminals",
    serviceGeneration: 1,
    canonicalBasePath: TERMINAL_SERVICE,
    originalUrl: `http://fixture${TERMINAL_SERVICE}/`,
    persistentExecutionId: binding,
    persistentKeepAliveMilliseconds: 0,
    client: { ipAddress: "127.0.0.1", networkScope: "loopback" },
    execution: {
      nodeId: "nod-0000000001",
      sandboxId: "sbx-0000000002",
      workerId: "wrk-0000000001",
      persistentExecutionId: binding,
    },
    user: { userId: "user:tester", username: "tester" },
    auth: {
      authenticated,
      realm: "user",
      userId: "user:tester",
      username: "tester",
    },
  });
  const screen = new Model({});
  const config = {
    enabled: true,
    target: { kind: "development", sandboxId: "sbx-0000000001" },
    arguments: ["/bin/bash", "-l"],
    environment: ["TERM=xterm-256color"],
    workingDirectory: "/workspace",
  };

  return {
    async run() {
      let refresh = 0;
      while (true) {
        const event = await callScreen({
          id: "retained-terminal-fixture",
          title: "Development terminals",
          schema: z.object({}),
          model: screen,
          customElements: [{
            id: "terminal",
            module: packageAssetURL("the8020/dev-core", "terminal.js"),
            styles: [packageAssetURL("the8020/dev-core", "terminal.css")],
            config: { ...config, refresh },
            preserve: true,
          }],
          layout: {
            schema: 1,
            id: "retained-terminal-layout",
            root: {
              id: "terminal-host",
              type: "custom",
              customElement: "terminal",
            },
          },
          header: {
            actions: [
              { id: "away", label: "Another screen" },
              { id: "refresh", label: "Refresh" },
            ],
          },
        });
        if (event.action === "refresh") {
          refresh++;
          continue;
        }
        await presentPage(async () => {
          await callScreen({
            id: "terminal-away",
            title: "Another screen",
            schema: z.object({}),
            model: new Model({}),
            header: { actions: [{ id: "return", label: "Return" }] },
          });
        });
      }
    },
    async serve(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname === "/" && !authenticated) {
        return new Response("<h1>Sign in</h1>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (!url.pathname.startsWith(`${TERMINAL_SERVICE}/`)) return undefined;
      if (!authenticated) {
        return Response.json({ error: "Sign in" }, { status: 401 });
      }
      // Match the shared router: ordinary HTTP uses the header, and browser
      // WebSockets use the query because their API cannot set that header.
      const route = request.headers.get("the8020-route") ??
        (request.headers.get("upgrade") === "websocket"
          ? url.searchParams.get("route")
          : null);
      if (route && !retained.has(route)) {
        return Response.json({ error: "Stale terminal owner" }, {
          status: 409,
        });
      }
      if (loading && url.pathname === `${TERMINAL_SERVICE}/list`) {
        await firstList.promise;
      }
      const meta = metadata(route ?? undefined);
      const logical = new Request(
        `${url.origin}${
          url.pathname.slice(TERMINAL_SERVICE.length)
        }${url.search}`,
        request,
      );
      if (request.headers.get("upgrade") === "websocket") {
        const { socket, response } = Deno.upgradeWebSocket(request, {
          protocol: TERMINAL_PROTOCOL,
        });
        const incoming = new TestSocket();
        sockets.add(incoming);
        const adapter: WebSocketSession = {
          protocol: TERMINAL_PROTOCOL,
          signal: incoming.signal,
          send: (data) =>
            socket.send(typeof data === "string" ? data : new Uint8Array(data)),
          receive: () => incoming.receive(),
          close: (code, reason) => {
            incoming.close(code, reason);
            if (socket.readyState < 2) socket.close(code, reason);
          },
        };
        socket.binaryType = "arraybuffer";
        socket.onmessage = (event) =>
          incoming.message(
            typeof event.data === "string"
              ? JSON.parse(event.data)
              : new Uint8Array(event.data),
          );
        socket.onclose = () => {
          incoming.close();
          sockets.delete(incoming);
        };
        socket.onopen = () => {
          void contexts.run(
            meta,
            () =>
              service.connectWebSocket(logical, {
                meta,
                signal: incoming.signal,
              }, adapter),
          ).then((response) => {
            if (!response.ok) {
              adapter.close(1008, "Terminal connection rejected");
            }
          }).catch((error) => {
            console.error(error);
            adapter.close(1011, "Terminal fixture failed");
          });
        };
        return response;
      }
      return await contexts.run(
        meta,
        () => service.fetch(logical, { meta, signal: request.signal }),
      );
    },
    async verify(page: Browser, openPage: () => Promise<Browser>) {
      const ready = (id?: string) =>
        visibleReady(page, id ? records.get(id)!.sessionId : undefined);
      await waitPage(
        page,
        `(() => {
        const loader = document.querySelector('.sandbox-console-loading');
        const display = document.querySelector('.sandbox-console-display');
        return loader && !loader.hidden && loader.querySelector('.sandbox-console-message').textContent === 'Loading…' && getComputedStyle(display).visibility === 'hidden' && loader.getBoundingClientRect().height === loader.parentElement.getBoundingClientRect().height;
      })()`,
        "full-height loading state before terminal list arrives",
      );
      loading = false;
      firstList.resolve();
      await ready();
      assertEquals(
        await page.evaluate(
          "document.querySelector('.sandbox-console-select').selectedOptions[0].text",
        ),
        "[1] Terminal 1",
      );
      assertEquals(
        await page.evaluate(
          `(() => { const viewport = document.querySelector('.sandbox-console-viewport'); const terminal = viewport.querySelector('.xterm'); return viewport.getBoundingClientRect().height === terminal.getBoundingClientRect().height; })()`,
        ),
        true,
      );
      assertEquals(terminals.size, 1);
      const first = [...terminals.keys()][0]!;
      const native = terminals.get(first)!;
      // A session discovered through shared metadata, outside this component.
      const external = "tty-9999999999";
      records.set(external, {
        ...records.get(first)!,
        terminalId: external,
        sessionId: "ssh-added",
        name: "SSH terminal",
      });
      try {
        await namedButton(page, "Refresh");
        await waitPage(
          page,
          "Boolean(document.querySelector('.sandbox-console-select option[value=ssh-added]'))",
          "page Refresh reloads the shared terminal list",
        );
        await ready(first);
        await namedButton(page, "Another screen");
      } finally {
        records.delete(external);
      }
      await namedButton(page, "Return");
      await waitPage(
        page,
        "!document.querySelector('.sandbox-console-select option[value=ssh-added]')",
        "re-entry reloads the shared terminal list",
      );
      await ready(first);
      const normal = await page.evaluate<
        { width: number; height: number; terminalHeight: number }
      >(`(() => {
        window.__retainedConsole = document.querySelector('.sandbox-console');
        return { width: innerWidth, height: innerHeight, terminalHeight: window.__retainedConsole.getBoundingClientRect().height };
      })()`);
      assertEquals(
        await page.evaluate(`(() => {
        const bar = document.querySelector('.sandbox-console-toolbar');
        return bar.contains(document.querySelector('.sandbox-console-status')) &&
          ['new','rename','close','refresh','fullscreen'].every(action => {
            const button = bar.querySelector('[data-terminal-action=' + action + ']');
            const icon = button.querySelector('.material-icon');
            return button.textContent.trim() === '' && button.title && button.getAttribute('aria-label') && icon &&
              parseFloat(getComputedStyle(icon, '::before').fontSize) <= icon.getBoundingClientRect().width &&
              icon.getBoundingClientRect().width < button.getBoundingClientRect().width;
          });
      })()`),
        true,
        "one toolbar with accessible icon buttons and status",
      );
      const fullscreenResizeStart = native.events.length;
      await button(page, "fullscreen");
      for (const width of [normal.width, 375]) {
        await page.command("Emulation.setDeviceMetricsOverride", {
          width,
          height: normal.height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await waitPage(
          page,
          `(() => {
          const terminal = document.querySelector('.sandbox-console');
          const rect = terminal.getBoundingClientRect();
          const bar = terminal.querySelector('.sandbox-console-toolbar');
          const status = terminal.querySelector('.sandbox-console-status').getBoundingClientRect();
          const navbar = document.querySelector('.navbar').getBoundingClientRect();
          return terminal === window.__retainedConsole && rect.left === 0 &&
            Math.abs(rect.top - navbar.bottom) < 1 && rect.right === innerWidth && rect.bottom === innerHeight &&
            bar.scrollWidth <= bar.clientWidth && status.top >= bar.getBoundingClientRect().top &&
            status.bottom <= bar.getBoundingClientRect().bottom &&
            terminal.querySelector('[data-terminal-action=fullscreen] [data-material-icon=fullscreen_exit]') &&
            document.elementFromPoint(navbar.right - 40, navbar.top + 20).closest('.navbar');
        })()`,
          "fullscreen fills only shell content on desktop and mobile",
        );
      }
      await until(
        () =>
          native.events.slice(fullscreenResizeStart).some((event) =>
            event.size
          ),
        "fullscreen resizes the existing PTY",
      );
      await page.command("Emulation.setDeviceMetricsOverride", {
        width: normal.width,
        height: normal.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await button(page, "fullscreen");
      await waitPage(
        page,
        `(() => {
        const terminal = document.querySelector('.sandbox-console');
        return terminal === window.__retainedConsole && !terminal.classList.contains('uui-content-fullscreen') &&
          Math.abs(terminal.getBoundingClientRect().height - ${normal.terminalHeight}) < 1 &&
          terminal.querySelector('[data-terminal-action=fullscreen] [data-material-icon=fullscreen]');
      })()`,
        "fullscreen restores normal layout without replacing the terminal",
      );
      await ready(first);
      await page.evaluate(
        "document.querySelector('.xterm-helper-textarea').focus()",
      );
      await page.command("Input.insertText", { text: "first line" });
      await until(
        () => textInput(native).includes("first line"),
        "typed terminal input",
      );
      await page.command("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: 2,
        windowsVirtualKeyCode: 65,
      });
      await page.command("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: 0,
        windowsVirtualKeyCode: 65,
      });
      await until(
        () => textInput(native).includes("\u0001"),
        "modified key input",
      );
      for (
        const [modifiers, expected] of [
          [0, "\r"],
          [8, "\u001b[13;2u"],
          [1, "\u001b\r"],
        ] as const
      ) {
        const before = textInput(native).length;
        await key(page, "Enter", "Enter", 13, modifiers);
        await until(() => textInput(native).length > before, "Enter input");
        assertEquals(textInput(native).slice(before), expected);
      }
      await key(page, "Escape", "Escape", 27);
      await until(() => textInput(native).endsWith("\u001b"), "Escape input");
      assertEquals(
        await page.evaluate("document.title"),
        "80|20 Development terminals",
      );
      await native.output("\u001b[?2004h");
      await waitPage(
        page,
        `Number(document.querySelector('.sandbox-console').dataset.outputSequence)===${native.events.length}`,
        "bracketed paste mode",
      );
      await page.evaluate(`(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'paste α😀\\nsecond line');
        document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      })()`);
      await until(
        () =>
          textInput(native).includes(
            "\u001b[200~paste α😀\rsecond line\u001b[201~",
          ),
        "Unicode bracketed paste",
      );
      const beforeOversized = textInput(native);
      await page.evaluate(`(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'x'.repeat(1048577));
        document.querySelector('.xterm-helper-textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      })()`);
      await waitPage(
        page,
        "document.querySelector('.sandbox-console-status').textContent.includes('Input buffer is full')",
        "bounded paste rejection",
      );
      assertEquals(textInput(native), beforeOversized);
      await button(page, "rename");
      await waitPage(
        page,
        "Boolean(document.querySelector('.sandbox-terminal-dialog[open]'))",
        "rename cancellation",
      );
      await key(page, "Escape", "Escape", 27);
      await waitPage(
        page,
        "!document.querySelector('.sandbox-terminal-dialog[open]')",
        "dialog Escape",
      );
      assertEquals(records.get(first)?.name, "Terminal 1");
      assertEquals(
        await page.evaluate("document.title"),
        "80|20 Development terminals",
      );
      await native.output(
        "\r\n" +
          Array.from({ length: 100 }, (_, row) => `scroll row ${row}\r\n`).join(
            "",
          ),
      );
      await waitPage(
        page,
        "document.querySelector('.xterm-viewport').scrollTop > 100",
        "scrollback output",
      );
      assertEquals(
        await page.evaluate("globalThis.__testRestoreScroll()"),
        true,
        "restored viewport accepts scroll before the next animation frame",
      );
      const viewport = await page.evaluate<
        { x: number; y: number; top: number }
      >(`(() => {
        const viewport = document.querySelector('.xterm-viewport');
        const bounds = viewport.getBoundingClientRect();
        return {x: bounds.left + 60, y: bounds.top + 35, top: viewport.scrollTop};
      })()`);
      await page.command("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: viewport.x,
        y: viewport.y,
        deltaX: 0,
        deltaY: -160,
      });
      await waitPage(
        page,
        `document.querySelector('.xterm-viewport').scrollTop < ${viewport.top}`,
        "terminal wheel scroll",
      );
      await page.command("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: viewport.x,
        y: viewport.y,
        button: "left",
        clickCount: 1,
      });
      await page.command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: viewport.x + 80,
        y: viewport.y,
        button: "left",
        buttons: 1,
      });
      await page.command("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: viewport.x + 80,
        y: viewport.y,
        button: "left",
        clickCount: 1,
      });
      await waitPage(
        page,
        "document.querySelector('.sandbox-console').dataset.hasSelection === 'true'",
        "terminal mouse selection",
      );
      const resizeStart = native.events.length;
      await page.command("Emulation.setDeviceMetricsOverride", {
        width: 1024,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await until(
        () => native.events.slice(resizeStart).some((event) => event.size),
        "native resize",
      );
      await waitPage(
        page,
        `Number(document.querySelector('.sandbox-console').dataset.outputSequence) >= ${
          resizeStart + 1
        }`,
        "ordered browser resize",
      );
      await button(page, "rename");
      await waitPage(
        page,
        "Boolean(document.querySelector('.sandbox-terminal-dialog[open] input'))",
        "rename dialog",
      );
      await page.evaluate(
        "document.querySelector('.sandbox-terminal-dialog input').value='Agent'; document.querySelector('.sandbox-terminal-dialog form').requestSubmit()",
      );
      await until(
        () => records.get(first)?.name === "Agent",
        "terminal rename",
      );
      await waitPage(
        page,
        "document.querySelector('.sandbox-console-select').selectedOptions[0].text === '[1] Agent'",
        "terminal rename reaches the browser",
      );
      await button(page, "new");
      await until(() => terminals.size === 2, "second terminal");
      const second = [...terminals.keys()][1]!;
      await ready(second);
      assertEquals(
        await page.evaluate(
          "document.querySelector('.sandbox-console-select').selectedOptions[0].text",
        ),
        "[2] Terminal 2",
      );
      assertEquals(native.closed, []);
      await choose(page, records.get(first)!.sessionId);
      await ready(first);

      await button(page, "fullscreen");
      await namedButton(page, "Another screen");
      await waitPage(
        page,
        "document.title.includes('Another screen')",
        "navigation away",
      );
      await native.output(
        "\r\n\u001b[?1049h\u001b[32mDetached application\u001b[0m\r\n",
      );
      await native.output(new Uint8Array([0xf0, 0x9f]));
      await namedButton(page, "Return");
      await ready(first);
      assertEquals(
        await page.evaluate(
          "document.querySelector('.sandbox-console').classList.contains('uui-content-fullscreen')",
        ),
        false,
        "navigation restores the normal terminal layout",
      );
      await native.output(new Uint8Array([0x98, 0x80]));
      await waitPage(
        page,
        `Number(document.querySelector('.sandbox-console').dataset.outputSequence)===${native.events.length}`,
        "snapshot continuation",
      );
      await page.command("Page.reload");
      await ready(first);
      assertEquals(terminals.size, 2);

      await page.command("Network.enable");
      await page.command("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await waitPage(
        page,
        "document.querySelector('.sandbox-console')?.dataset.terminalState==='disconnected'",
        "offline detach",
      );
      const beforeQuery = native.replies.length;
      await native.output("\r\noutput while offline\u001b[6n");
      assertEquals(native.replies.length, beforeQuery + 1);
      await page.command("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await ready(first);
      assertEquals(native.closed, []);
      assertEquals(native.replies.length, beforeQuery + 1);

      const other = await openPage();
      try {
        await waitPage(
          other,
          "Boolean(document.querySelector('[data-terminal-action=takeover]:not([hidden])'))",
          "exclusive controller",
        );
        assertEquals(
          await other.evaluate(`(() => {
            const button = document.querySelector('[data-terminal-action=takeover]');
            const message = document.querySelector('.sandbox-console-message');
            return !!button.closest('.sandbox-console-loading') &&
              button.getBoundingClientRect().height > 0 &&
              button.getBoundingClientRect().top >= message.getBoundingClientRect().bottom;
          })()`),
          true,
          "Take control is below the message in the terminal content",
        );
        await button(other, "takeover");
        await visibleReady(other, records.get(first)!.sessionId);
        await waitPage(
          page,
          "document.querySelector('.sandbox-console')?.dataset.terminalState==='disconnected'",
          "control transfer",
        );
        await button(page, "refresh");
        await waitPage(
          page,
          "Boolean(document.querySelector('[data-terminal-action=takeover]:not([hidden])'))",
          "refresh does not steal active control",
        );
        let detached = native.detached.length;
        await namedButton(other, "Another screen");
        await until(
          () => native.detached.length > detached,
          "other view released",
        );
        await button(page, "refresh");
        await ready(first);

        await namedButton(other, "Return");
        await waitPage(
          other,
          "Boolean(document.querySelector('[data-terminal-action=takeover]:not([hidden])'))",
          "re-entry attempts ordinary control",
        );
        await choose(page, records.get(second)!.sessionId);
        await ready(second);
        await button(other, "refresh");
        await visibleReady(other, records.get(first)!.sessionId);
        await choose(page, records.get(first)!.sessionId);
        await waitPage(
          page,
          "Boolean(document.querySelector('[data-terminal-action=takeover]:not([hidden])'))",
          "selecting an occupied terminal waits for control",
        );
        detached = native.detached.length;
        await namedButton(other, "Another screen");
        await until(
          () => native.detached.length > detached,
          "other view released again",
        );
        await choose(page, records.get(second)!.sessionId);
        await ready(second);
        await choose(page, records.get(first)!.sessionId);
        await ready(first);
        // Both fixture tabs share a UUI continuation; restore it before reload.
        await namedButton(other, "Return");
        await waitPage(
          other,
          "Boolean(document.querySelector('[data-terminal-action=takeover]:not([hidden])'))",
          "return preserves the other client's control",
        );
      } finally {
        await other.command("Page.close").catch(() => {});
        other.close();
      }
      await page.command("Page.reload");
      await ready(first);

      authenticated = false;
      await page.command("Page.reload");
      await waitPage(
        page,
        "document.body.innerText.includes('Sign in') && !document.querySelector('.sandbox-console')",
        "fixture logout",
      );
      await native.output("\r\nstill alive after logout");
      assertEquals(native.closed, []);
      authenticated = true;
      await page.command("Page.reload");
      await ready(first);
      assertEquals(terminals.size, 2);
      const screenshot = await page.command<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
      );
      await Deno.writeFile(
        "/tmp/8020-retained-terminal-browser.png",
        Uint8Array.from(
          atob(screenshot.data),
          (character) => character.charCodeAt(0),
        ),
      );

      native.exit();
      await waitPage(
        page,
        "document.querySelector('.sandbox-console')?.dataset.terminalState==='exited'",
        "process exit",
      );
      await namedButton(page, "Another screen");
      await namedButton(page, "Return");
      await visibleReady(page, "1");
      const recreated = [...terminals.keys()].at(-1)!;
      assertEquals(terminals.size, 3);
      assertEquals(records.get(recreated)?.sessionId, "1");
      assertEquals(
        await page.evaluate(
          "document.querySelector('.sandbox-console-select').selectedOptions[0].text",
        ),
        "[1] Agent",
      );
      await button(page, "close");
      await waitPage(
        page,
        "Boolean(document.querySelector('.sandbox-terminal-dialog[open]'))",
        "close confirmation",
      );
      await page.evaluate(
        "document.querySelector('.sandbox-terminal-dialog form').requestSubmit()",
      );
      await ready(second);
      assertEquals(native.closed, [first]);
      assertEquals(terminals.get(second)!.closed, []);
      assertEquals(records.size, 1);
      assertEquals(terminals.size, 3);
      assertEquals(terminals.get(recreated)!.closed, [recreated]);
      openError = "development sandbox is not running";
      const attempts = openAttempts;
      await button(page, "new");
      await until(() => openAttempts >= attempts + 2, "failed open retries");
      await waitPage(
        page,
        "document.querySelector('.sandbox-console-status').textContent === 'Terminal request failed (500). Reconnecting…'",
        "recovery preserves the HTTP failure",
      );
      assertEquals(
        records.size,
        1,
        "failed opens do not create terminal names",
      );
      openError = undefined;
      await visibleReady(page, "3");
      for (const id of ["4", "5"]) {
        await button(page, "new");
        await visibleReady(page, id);
      }
      assertEquals([...records.values()].map((record) => record.sessionId), [
        "2",
        "3",
        "4",
        "5",
      ]);
      console.log(
        "Retained terminal browser checks passed: named controls, input, snapshot continuation, navigation, reload, network loss, control transfer, fixture logout/login, exit and close.",
      );
    },
    async close() {
      for (const socket of sockets) socket.close();
      for (const record of [...records.values()]) {
        await contexts.run(
          metadata(record.persistentExecutionId),
          () =>
            workerFunctions["terminal.close"]({
              terminalId: record.terminalId,
              persistentExecutionId: record.persistentExecutionId,
            }),
        );
      }
      await Promise.allSettled([...lifetimes]);
      releaseContext();
    },
  };
}

function textInput(native: TestTerminals): string {
  return native.writes.map((data) => new TextDecoder().decode(data)).join("");
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function waitPage(
  page: Browser,
  expression: string,
  label: string,
): Promise<void> {
  await until(
    () => page.evaluate<boolean>(expression).catch(() => false),
    label,
  );
}
async function visibleReady(page: Browser, id?: string): Promise<void> {
  await waitPage(
    page,
    `(() => { const e=document.querySelector('.sandbox-console'); return Boolean(e && !e.closest('[hidden],[inert]') && e.dataset.terminalState==='connected' && !e.querySelector('[data-terminal-action=new]').disabled ${
      id ? `&& e.dataset.terminalId===${JSON.stringify(id)}` : ""
    }); })()`,
    "connected terminal",
  );
}
async function button(page: Browser, action: string): Promise<void> {
  await waitPage(
    page,
    `(() => { const e=document.querySelector('[data-terminal-action=${action}]'); if(!e || e.disabled || e.hidden) return false; e.click(); return true; })()`,
    `${action} action`,
  );
}
async function namedButton(page: Browser, label: string): Promise<void> {
  await waitPage(
    page,
    `(() => {const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${
      JSON.stringify(label)
    } && !e.disabled && !e.closest('[hidden],[inert]')); if(!e)return false; e.click();return true;})()`,
    label,
  );
}
async function choose(page: Browser, terminal: string): Promise<void> {
  await page.evaluate(
    `(() => { const e=document.querySelector('.sandbox-console-select'); e.value=${
      JSON.stringify(terminal)
    }; e.dispatchEvent(new Event('change',{bubbles:true})); })()`,
  );
}

async function key(
  page: Browser,
  key: string,
  code: string,
  windowsVirtualKeyCode: number,
  modifiers = 0,
): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) {
    await page.command("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode,
      modifiers,
    });
  }
}
