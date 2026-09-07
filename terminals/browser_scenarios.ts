import { assertEquals } from "@std/assert";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestMetadata, WebSocketSession } from "@the8020/http";
import type { kernel, TerminalAttachment } from "@the8020/kernel";
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
  const attachments = new Map<string, TestTerminals>();
  const retained = new Set<string>();
  const lifetimes = new Set<Promise<void>>();
  const sockets = new Set<TestSocket>();
  let ordinal = 0;
  let attachmentOrdinal = 0;
  let bindingOrdinal = 0;
  let requestOrdinal = 0;
  let authenticated = true;
  const id = (prefix: string, n: number) =>
    `${prefix}-${String(n).padStart(10, "0")}`;
  const attach = (native: TestTerminals, inner: TerminalAttachment) => {
    const value = { ...inner, attachmentId: id("att", ++attachmentOrdinal) };
    attachments.set(value.attachmentId, native);
    return value;
  };
  const nativeAPI: typeof kernel.terminals = {
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
    get: (user, terminal) => {
      const record = records.get(terminal);
      return Promise.resolve(
        record?.authenticatedUserId === user ? record : undefined,
      );
    },
    create: (record) => {
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
      assertEquals(input.function, "terminal.close");
      return await workerFunctions["terminal.close"](input.input) as Result;
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
      while (true) {
        await callScreen({
          id: "retained-terminal-fixture",
          title: "Development terminals",
          schema: z.object({}),
          model: screen,
          customElements: [{
            id: "terminal",
            module: packageAssetURL("the8020/dev-core", "terminal.js"),
            styles: [packageAssetURL("the8020/dev-core", "terminal.css")],
            config,
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
          header: { actions: [{ id: "away", label: "Another screen" }] },
        });
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
      const ready = (id?: string) => visibleReady(page, id);
      await ready();
      assertEquals(terminals.size, 1);
      const first = [...terminals.keys()][0]!;
      const native = terminals.get(first)!;
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
      await button(page, "new");
      await until(() => terminals.size === 2, "second terminal");
      const second = [...terminals.keys()][1]!;
      await ready(second);
      assertEquals(native.closed, []);
      await choose(page, first);
      await ready(first);

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
        await button(other, "takeover");
        await visibleReady(other, first);
        await waitPage(
          page,
          "document.querySelector('.sandbox-console')?.dataset.terminalState==='disconnected'",
          "control transfer",
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
      assertEquals(terminals.size, 2);
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
): Promise<void> {
  for (const type of ["keyDown", "keyUp"]) {
    await page.command("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode,
    });
  }
}
