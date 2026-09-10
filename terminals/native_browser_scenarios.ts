import { assert, assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";
import {
  verifyNativeNamedSessions,
  verifyNativeSSH,
  verifyNativeSSHShell,
} from "./native_ssh_scenarios.ts";

/** Real users, database, service Workers and gVisor PTYs in disposable nodes. */
export default async function verify(context: NativeBrowserFixtureContext) {
  const {
    page,
    click,
    clickRow,
    enterTerminal,
    waitForPage,
    waitForScreen,
  } = context;
  const ready = (id?: string, target = page) =>
    waitForPage(
      target,
      `(() => { const e=document.querySelector('.sandbox-console'); return e &&
        !e.closest('[hidden],[inert]') && e.dataset.terminalState==='connected' &&
        !e.querySelector('[data-terminal-action=new]').disabled ${
        id ? `&& e.dataset.terminalId===${JSON.stringify(id)}` : ""
      }; })()`,
      "native retained terminal connected",
      60_000,
    );
  const selected = () =>
    page.evaluate<string>(
      "document.querySelector('.sandbox-console').dataset.terminalId",
    );
  const choose = async (id: string, target = page) => {
    await target.evaluate(`(() => {
      const e=document.querySelector('.sandbox-console-select');
      e.value=${JSON.stringify(id)};
      e.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await ready(id, target);
  };
  const output = async (
    command: string,
    marker: string,
    timeout = 15_000,
    target = page,
  ) => {
    const start = target.websocketFrames.length;
    await enterTerminal(target, command);
    const deadline = Date.now() + timeout;
    while (true) {
      const value = terminalOutput(target, start);
      const index = value.indexOf(marker);
      if (
        index >= 0 && (marker.endsWith("\x1f") ||
          value.indexOf("\x1f", index + marker.length) >= 0)
      ) return value;
      if (Date.now() >= deadline) {
        throw new Error(`Native terminal did not output ${marker}: ${value}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const terminalButton = (action: string) =>
    click(page, `[data-terminal-action=${action}]`);
  const closeTerminal = async () => {
    await terminalButton("close");
    await waitForPage(
      page,
      "Boolean(document.querySelector('.sandbox-terminal-dialog[open]'))",
      "terminal close confirmation",
    );
    await page.evaluate(
      "document.querySelector('.sandbox-terminal-dialog form').requestSubmit()",
    );
  };
  const login = async () => {
    await context.setValue(
      page,
      'input[name="username"]',
      context.credentials.username,
    );
    await context.setValue(
      page,
      'input[name="password"]',
      context.credentials.password,
    );
    await click(page, 'button[type="submit"]');
    await waitForScreen(page, "Welcome to 80|20");
  };

  await clickRow(page, "the8020/dev-core/development-test");
  await waitForScreen(page, "Development", 60_000);
  await ready();
  const first = await selected();
  assertEquals(first, "1", "first numeric session ID");
  const initial = await output(
    'export RETAINED_PROOF_PID=$$; printf \'\\036PID:%s:TERM:%s\\037\\n\' "$$" "$TERM"',
    "\x1ePID:",
  );
  const pid = initial.split("\x1ePID:")[1]?.split(
    ":TERM:xterm-256color\x1f",
  )[0];
  assert(pid, "Bash and TERM through the native retained service");
  console.log(`Native terminal created: ${first}, Bash PID ${pid}`);

  await terminalButton("rename");
  await waitForPage(
    page,
    "Boolean(document.querySelector('.sandbox-terminal-dialog input'))",
    "terminal rename",
  );
  await page.evaluate(`(() => {
    document.querySelector('.sandbox-terminal-dialog input').value='Native agent';
    document.querySelector('.sandbox-terminal-dialog form').requestSubmit();
  })()`);
  await waitForPage(
    page,
    "document.querySelector('.sandbox-console-select').selectedOptions[0]?.text==='[1] Native agent'",
    "retained name",
  );
  await terminalButton("new");
  await waitForPage(
    page,
    `document.querySelector('.sandbox-console').dataset.terminalId!==${
      JSON.stringify(first)
    }`,
    "second native terminal",
  );
  await ready();
  const second = await selected();
  const secondOutput = await output(
    "printf '\\036SECOND:%s\\037\\n' \"$$\"",
    "\x1eSECOND:",
  );
  const secondPID = secondOutput.split("\x1eSECOND:")[1]?.split("\x1f")[0];
  assert(secondPID && secondPID !== pid, "independent native shell processes");
  await choose(first);

  await click(page, "#screen-back");
  await waitForScreen(page, "Welcome to 80|20");
  await clickRow(page, "the8020/dev-core/development-test");
  await waitForScreen(page, "Development");
  await ready(first);
  assert((await output(
    'printf \'\\036SURVIVED:%s:%s\\037\\n\' "$$" "$RETAINED_PROOF_PID"',
    "\x1eSURVIVED:",
  )).includes(`\x1eSURVIVED:${pid}:${pid}\x1f`));

  // Hide the cursor and compare rendered text pixels through a fresh mount.
  await output(
    "printf '\\033[2J\\033[H\\033[32mNative α😀 display\\033[0m\\r\\n\\033[?25l\\036PAINTED\\037\\n'",
    "\x1ePAINTED\x1f",
  );
  const beforeReload = await canvasPixels(page);
  await page.command("Page.reload");
  await ready(first);
  assertEquals(await canvasPixels(page), beforeReload, "fresh browser display");
  assertEquals(
    await page.evaluate(
      "document.querySelector('.sandbox-console-select').options.length",
    ),
    2,
    "reload must not create another process",
  );

  // An ordinary sandbox command releases the query and observes its result
  // independently of Chromium's offline network context. Neither command
  // admission nor completion relies on a timer or reconnecting this terminal.
  await output(
    "rm -f /tmp/8020-query-go /tmp/8020-query-result; printf '\\036QUERY_ARMED\\037\\n'; while [ ! -e /tmp/8020-query-go ]; do sleep 0.05; done; retained_modes=$(stty -g); stty -echo -icanon min 1 time 0; printf '\\033[6n'; IFS= read -r -s -d R -t 5 retained_reply; retained_answer=$?; IFS= read -r -s -n 1 -t 0.3 retained_extra; retained_duplicate=$?; stty \"$retained_modes\"; printf '%s:%s:PID:%s' \"$retained_answer\" \"$retained_duplicate\" \"$$\" > /tmp/8020-query-result; printf '\\r\\nDetached output α😀\\r\\n'",
    "\x1eQUERY_ARMED\x1f",
  );
  await page.command("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await waitForPage(
    page,
    "document.querySelector('.sandbox-console')?.dataset.terminalState==='disconnected'",
    "native network detach",
  );
  const detached = await context.admin([
    "dev-core.sandbox.shell",
    context.credentials.username,
    "--command",
    "touch /tmp/8020-query-go; timeout 10 bash -c 'while [ ! -s /tmp/8020-query-result ]; do sleep 0.05; done'; cat /tmp/8020-query-result",
  ]);
  assertEquals(
    (detached.shell as { output: string }).output,
    `0:142:PID:${pid}`,
    "one answer while offline",
  );
  await page.command("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await ready(first);
  const query = await output(
    'printf \'\\036QUERY:%s:%s:PID:%s\\037\\n\' "$retained_answer" "$retained_duplicate" "$$"',
    "\x1eQUERY:",
  );
  assert(
    query.includes(`\x1eQUERY:0:142:PID:${pid}\x1f`),
    "one detached query answer",
  );
  console.log("Native query answered once while the browser was offline");

  // A different browser cannot silently take over input or resize ownership.
  const observer = await context.openPage();
  await waitForScreen(observer, "Welcome to 80|20", 60_000);
  await clickRow(observer, "the8020/dev-core/development-test");
  await waitForScreen(observer, "Development");
  await waitForPage(
    observer,
    "document.querySelector('.sandbox-console-select')?.options.length===2 && !document.querySelector('.sandbox-console-select').disabled",
    "existing native terminals in a second tab",
  );
  await choose(second, observer);
  await observer.evaluate(`(() => {
    const e=document.querySelector('.sandbox-console-select');
    e.value=${JSON.stringify(first)};
    e.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitForPage(
    observer,
    "!document.querySelector('[data-terminal-action=takeover]').hidden",
    "explicit native control transfer",
  );
  await click(observer, "[data-terminal-action=takeover]");
  await ready(first, observer);
  await waitForPage(
    page,
    "document.querySelector('.sandbox-console')?.dataset.terminalState==='disconnected'",
    "previous native controller released",
  );
  await page.command("Page.bringToFront");
  await terminalButton("refresh");
  await waitForPage(
    page,
    "!document.querySelector('[data-terminal-action=takeover]').hidden",
    "explicit native control reclamation",
  );
  await terminalButton("takeover");
  await ready(first);
  await observer.command("Page.close").catch(() => {});
  observer.close();
  await page.command("Page.bringToFront");
  console.log("Native control transferred explicitly between browser tabs");

  await context.clickSessionMenuAction(page, "#session-logout");
  await waitForPage(
    page,
    "location.pathname==='/the8020/uui/login/' && Boolean(document.querySelector('input[name=username]'))",
    "real users logout",
  );
  const cookies = await page.command<{ cookies: { name: string }[] }>(
    "Network.getCookies",
    { urls: [context.baseURL] },
  );
  assert(!cookies.cookies.some((cookie) => cookie.name === "the8020_auth"));
  // The login page intentionally disallows fetch through CSP. Test the public
  // authenticated endpoint from the harness after checking the browser cookie.
  const unauthenticated = await fetch(
    `${context.baseURL}/the8020/dev-core/terminals/list`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetKind: "development",
        targetSandboxId: "sbx-0000000000",
      }),
    },
  );
  assertEquals(
    unauthenticated.status,
    401,
    "logged-out terminal admission",
  );
  await unauthenticated.body?.cancel();
  await login();
  await clickRow(page, "the8020/dev-core/development-test");
  await waitForScreen(page, "Development");
  await ready(first);
  assert((await output(
    'printf \'\\036LOGIN:%s:%s\\037\\n\' "$$" "$RETAINED_PROOF_PID"',
    "\x1eLOGIN:",
  )).includes(`\x1eLOGIN:${pid}:${pid}\x1f`));

  console.log("Installing htop inside the disposable development sandbox");
  const installed = await output(
    "(command -v htop >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq htop)) >/tmp/8020-htop-install.log 2>&1; printf '\\036HTOP_INSTALL:%s\\037\\n' \"$?\"; htop --version",
    "\x1eHTOP_INSTALL:",
    120_000,
  );
  assert(
    installed.includes("\x1eHTOP_INSTALL:0\x1f"),
    "native htop installation",
  );
  const htopStart = page.websocketFrames.length;
  await enterTerminal(
    page,
    "bash -c 'echo $$ > /tmp/8020-htop.pid; exec htop'; printf '\\036HTOP_EXIT\\037\\n'",
  );
  const appOutput = async (start: number, text: string) => {
    const deadline = Date.now() + 15_000;
    while (!terminalOutput(page, start).includes(text)) {
      if (Date.now() > deadline) {
        throw new Error(
          `htop did not render ${text}: ${
            terminalOutput(page, start).slice(-8000)
          }`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const key = async (name: string, code: string, keyCode: number) => {
    const start = page.websocketFrames.length;
    for (const type of ["keyDown", "keyUp"]) {
      await page.command("Input.dispatchKeyEvent", {
        type,
        key: name,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
    }
    await terminalMessage(page, "input-ack", start);
    return start;
  };
  await appOutput(htopStart, "Tasks:");
  await click(page, ".xterm-helper-textarea");
  const screenshot = await page.command<{ data: string }>(
    "Page.captureScreenshot",
    { format: "png" },
  );
  await Deno.writeFile(
    "/tmp/8020-native-htop.png",
    Uint8Array.from(
      atob(screenshot.data),
      (character) => character.charCodeAt(0),
    ),
  );
  await appOutput(await key("F2", "F2", 113), "Display options");
  await key("Escape", "Escape", 27);
  assertEquals(await page.evaluate("document.title"), "80|20 Development");
  await appOutput(await key("F1", "F1", 112), "htop");
  await key("Escape", "Escape", 27);
  await appOutput(await key("F6", "F6", 117), "Sort by");
  await key("Escape", "Escape", 27);
  await key("ArrowDown", "ArrowDown", 40);
  await key("ArrowUp", "ArrowUp", 38);
  await key("PageDown", "PageDown", 34);
  await key("PageUp", "PageUp", 33);
  await key("F3", "F3", 114);
  await page.command("Input.insertText", { text: "htop" });
  await key("Backspace", "Backspace", 8);
  await page.command("Input.insertText", { text: "p" });
  await key("Escape", "Escape", 27);
  const resizeStart = page.websocketFrames.length;
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1024,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const resized = await terminalMessage(page, "resize", resizeStart);
  const size = resized.size as { columns: number; rows: number };
  await choose(second);
  const htopProcess = await output(
    'htop_pid=$(cat /tmp/8020-htop.pid); kill -0 "$htop_pid" && printf \'\\036HTOP_PID:%s\\037\\n\' "$htop_pid"',
    "\x1eHTOP_PID:",
  );
  const htopPID = htopProcess.split("\x1eHTOP_PID:")[1]?.split("\x1f")[0];
  assert(htopPID, "htop survives switching to the other native terminal");
  const nativeSize = await output(
    "printf '\\036HTOP_SIZE:%s\\037\\n' \"$(stty size < /proc/$htop_pid/fd/0)\"",
    "\x1eHTOP_SIZE:",
  );
  assert(nativeSize.includes(`\x1eHTOP_SIZE:${size.rows} ${size.columns}\x1f`));
  await verifyNativeSSH(context, first, htopPID);
  await choose(first);
  await page.command("Page.reload");
  await ready(first);
  await click(page, ".xterm-helper-textarea");
  await appOutput(await key("F2", "F2", 113), "Display options");
  await key("Escape", "Escape", 27);
  await appOutput(await key("F10", "F10", 121), "\x1eHTOP_EXIT\x1f");
  assert((await output(
    'printf \'\\036HTOP_DONE:%s:%s\\037\\n\' "$$" "$(cat /tmp/8020-htop.pid)"',
    "\x1eHTOP_DONE:",
  )).includes(`\x1eHTOP_DONE:${pid}:${htopPID}\x1f`));
  console.log(
    `Native htop PID ${htopPID}: rendering, function keys, search editing, scrolling, resize, switch and reload checked`,
  );

  // SSH must take over the browser's currently attached shell.
  await verifyNativeSSHShell(context, first, pid, async () => {
    await waitForPage(
      page,
      "!document.querySelector('[data-terminal-action=takeover]').hidden",
      "SSH retains exclusive control until explicit takeover",
    );
    await terminalButton("takeover");
    await ready(first);
  });
  assert(
    (await output(
      'printf \'\\036SSH_SURVIVED:%s:%s\\037\\n\' "$$" "$RETAINED_PROOF_PID"',
      "\x1eSSH_SURVIVED:",
    )).includes(`\x1eSSH_SURVIVED:${pid}:${pid}\x1f`),
  );

  await enterTerminal(page, "exit 7");
  await waitForPage(
    page,
    "document.querySelector('.sandbox-console')?.dataset.terminalState==='exited'",
    "native process exit",
  );
  await closeTerminal();
  await ready(second);
  assert((await output(
    "printf '\\036REMAINING:%s\\037\\n' \"$$\"",
    "\x1eREMAINING:",
  )).includes(`\x1eREMAINING:${secondPID}\x1f`));
  await closeTerminal();
  await waitForPage(
    page,
    "document.querySelector('.sandbox-console-select').options.length===0",
    "explicit native cleanup",
  );
  console.log(
    "Native retained terminal checks passed: names, distinct PIDs, navigation, pixel-identical reload, network loss, detached query, real logout/login, htop, process exit, independent explicit close.",
  );
  await verifyNativeNamedSessions(context);
}

function terminalOutput(
  page: NativeBrowserFixtureContext["page"],
  start: number,
) {
  const decoder = new TextDecoder();
  return page.websocketFrames.slice(start).filter((frame) => frame.opcode === 2)
    .map((frame) => {
      const bytes = Uint8Array.from(
        atob(frame.payloadData),
        (c) => c.charCodeAt(0),
      );
      return decoder.decode(bytes.subarray(8), { stream: true });
    }).join("");
}

async function terminalMessage(
  page: NativeBrowserFixtureContext["page"],
  type: string,
  start: number,
) {
  const deadline = Date.now() + 15_000;
  while (true) {
    for (const frame of page.websocketFrames.slice(start)) {
      if (frame.opcode !== 1) continue;
      const message = JSON.parse(frame.payloadData) as Record<string, unknown>;
      if (message.type === type) return message;
    }
    if (Date.now() > deadline) {
      const state = await page.evaluate(`({
        focus: document.activeElement?.className,
        visibility: document.visibilityState,
        connected: document.querySelector('.sandbox-console')?.dataset.terminalState,
      })`);
      throw new Error(`No native terminal ${type}: ${JSON.stringify(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function canvasPixels(page: NativeBrowserFixtureContext["page"]) {
  return await page.evaluate<string>(`(async () => {
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const canvas=document.querySelector('.xterm-text-layer');
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)),
      byte=>byte.toString(16).padStart(2,'0')).join('');
  })()`);
}
