import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type {
  CustomElementContext,
  CustomElementInstance,
} from "/p/the8020/uui/custom_element.ts";
import {
  installTerminalView,
  MAX_SNAPSHOT_BYTES,
  restoreTerminal,
  retainedScrollback,
  terminalTheme,
} from "../state.ts";
import {
  outputSequence,
  SESSION_ID,
  TERMINAL_PROTOCOL,
  TERMINAL_SERVICE,
  type TerminalItem,
  VIEW_QUEUE_BYTES,
  VIEW_QUEUE_FRAMES,
} from "../protocol.ts";

interface Size {
  columns: number;
  rows: number;
}
interface Configuration {
  target: { kind: "development" | "runtime"; sandboxId: string };
  arguments: string[];
  environment: string[];
  workingDirectory: string;
}
interface Connection {
  socket: WebSocket;
  abort: AbortController;
  ordered: Promise<void>;
  queuedBytes: number;
  queuedFrames: number;
  sequence: number;
  ready: boolean;
  exited: boolean;
  input: Uint8Array<ArrayBuffer>[];
  inputBytes: number;
  inFlight?: Uint8Array<ArrayBuffer>;
  resize?: Size;
  lastResize?: Size;
  heartbeat?: ReturnType<typeof setTimeout>;
  awaitingPong: boolean;
  stopped: boolean;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export default function mount(
  { host, config, signal, renderText }: CustomElementContext,
): CustomElementInstance {
  const instance = new RetainedConsole(config, renderText);
  host.append(instance.element);
  signal.addEventListener("abort", () => instance.dispose(), { once: true });
  return instance;
}

class RetainedConsole implements CustomElementInstance {
  readonly element = document.createElement("div");
  readonly #terminal = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: retainedScrollback(80, 24),
    cursorBlink: true,
    convertEol: false,
    allowProposedApi: true,
    disableStdin: true,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 14,
    theme: {
      ...terminalTheme,
      selectionBackground: "rgba(88, 166, 255, 0.62)",
      selectionInactiveBackground: "rgba(88, 166, 255, 0.42)",
    },
  });
  readonly #fit = new FitAddon();
  readonly #lifetime = new AbortController();
  readonly #select: HTMLSelectElement;
  readonly #status: HTMLElement;
  readonly #viewport: HTMLElement;
  readonly #loading: HTMLElement;
  readonly #loadingMessage: HTMLElement;
  readonly #takeover: HTMLButtonElement;
  readonly #observer: ResizeObserver;
  readonly #clientId = stored("the8020.dev-core.terminal-client") ??
    crypto.randomUUID();
  #configuration?: Configuration;
  #signature = "";
  #storageKey = "";
  #operations = new AbortController();
  #items: TerminalItem[] = [];
  #selected?: TerminalItem;
  #connection?: Connection;
  #reconnect?: ReturnType<typeof setTimeout>;
  #retryDelay = 250;
  #active = false;
  #enabled = false;
  #pageHidden = false;
  #disposed = false;
  #initialized = false;
  #refreshRevision: unknown;
  #busy = false;
  #uncertainInput = false;
  #connecting = false;
  #connectEpoch = 0;
  #display: Promise<void> = Promise.resolve();

  constructor(
    config: Record<string, unknown>,
    readonly renderText: CustomElementContext["renderText"],
  ) {
    save("the8020.dev-core.terminal-client", this.#clientId);
    this.element.className = "sandbox-console";
    this.element.innerHTML = `<div class="sandbox-console-toolbar">
      <select class="sandbox-console-select" aria-label="Terminal"></select>
      <button type="button" data-terminal-action="new" aria-label="New terminal" title="New terminal"></button>
      <button type="button" data-terminal-action="rename" aria-label="Rename terminal" title="Rename terminal"></button>
      <button type="button" data-terminal-action="refresh" aria-label="Refresh terminals" title="Refresh terminals"></button>
      <button type="button" data-terminal-action="fullscreen"></button>
      <button type="button" data-terminal-action="close" aria-label="Close terminal" title="Close terminal"></button>
      <div class="sandbox-console-status" role="status" aria-live="polite"></div>
    </div>
    <div class="sandbox-console-viewport"><div class="sandbox-console-loading"><div>
      <div class="sandbox-console-message" role="status">Loading…</div>
      <button type="button" data-terminal-action="takeover" hidden>Take control</button>
    </div></div><div class="sandbox-console-display"></div></div>`;
    for (
      const [action, icon] of Object.entries({
        new: "add",
        rename: "edit",
        close: "close",
        refresh: "refresh",
      })
    ) {
      renderText(
        this.element.querySelector(`[data-terminal-action="${action}"]`)!,
        `[[icon=${icon}]]`,
      );
    }
    this.#fullscreen(false);
    this.element.querySelector('[data-terminal-action="fullscreen"]')!
      .addEventListener("click", () =>
        this.#fullscreen(
          !this.element.classList.contains("uui-content-fullscreen"),
        ));
    this.#select = this.element.querySelector("select")!;
    this.#status = this.element.querySelector(".sandbox-console-status")!;
    this.#viewport = this.element.querySelector(".sandbox-console-viewport")!;
    this.#loading = this.element.querySelector(".sandbox-console-loading")!;
    this.#loadingMessage = this.element.querySelector(
      ".sandbox-console-message",
    )!;
    this.#takeover = this.element.querySelector(
      '[data-terminal-action="takeover"]',
    )!;
    this.#terminal.loadAddon(this.#fit);
    installTerminalView(this.#terminal);
    this.#terminal.open(
      this.element.querySelector(".sandbox-console-display")!,
    );
    try {
      this.#terminal.loadAddon(new CanvasAddon());
    } catch { /* xterm's DOM renderer handles unavailable Canvas2D. */ }
    this.#terminal.onData((value) => this.#input(value));
    this.#terminal.onBinary((value) => this.#input(value, true));
    this.#terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.key !== "Enter" || !event.shiftKey || event.altKey ||
        event.ctrlKey || event.metaKey || event.isComposing ||
        event.keyCode === 229
      ) return true;
      // xterm 5.5 otherwise encodes Shift+Enter as plain Enter.
      // ponytail: CSI-u for this key only; broader modes need shared engine support.
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keydown") this.#terminal.input("\u001b[13;2u");
      return false;
    });
    this.#terminal.onSelectionChange(() =>
      this.element.dataset.hasSelection = String(this.#terminal.hasSelection())
    );
    this.#viewport.addEventListener("click", () => {
      if (this.#connection?.ready) this.#terminal.focus();
    });
    this.#observer = new ResizeObserver(() => this.#resize());
    this.#observer.observe(this.#viewport);
    this.#select.onchange = () => {
      this.#choose(this.#items.find((item) => item.id === this.#select.value));
      void this.#connect();
    };
    this.element.querySelector('[data-terminal-action="new"]')!
      .addEventListener("click", () => void this.#run(() => this.#create()));
    this.element.querySelector('[data-terminal-action="refresh"]')!
      .addEventListener("click", () => void this.#run(() => this.#refresh()));
    this.element.querySelector('[data-terminal-action="rename"]')!
      .addEventListener("click", () => void this.#edit("rename"));
    this.element.querySelector('[data-terminal-action="close"]')!
      .addEventListener("click", () => void this.#edit("close"));
    this.#takeover.onclick = () => {
      this.#detach();
      void this.#connect(true);
    };
    const options = { signal: this.#lifetime.signal };
    addEventListener("offline", () => {
      this.#detach();
      this.#setStatus("Offline", "disconnected");
    }, options);
    addEventListener("online", () => void this.#connect(), options);
    addEventListener("pagehide", () => {
      this.#pageHidden = true;
      this.#initialized = false;
      this.#detach();
    }, options);
    addEventListener("pageshow", () => {
      this.#pageHidden = false;
      this.#start();
    }, options);
    this.update(config);
  }

  update(config: Record<string, unknown>): void {
    const parsed = configuration(config);
    const signature = JSON.stringify(parsed);
    this.#enabled = config.enabled === true && parsed !== undefined;
    if (config.refresh !== this.#refreshRevision) {
      this.#refreshRevision = config.refresh;
      this.#initialized = false;
    }
    if (signature !== this.#signature) {
      this.#detach();
      this.#operations.abort();
      this.#operations = new AbortController();
      this.#busy = false;
      this.#signature = signature;
      this.#configuration = parsed;
      this.#initialized = false;
      this.#items = [];
      this.#choose(undefined);
      this.#storageKey = parsed
        ? `the8020.dev-core.selected-terminal:${parsed.target.kind}:${parsed.target.sandboxId}`
        : "";
    }
    if (parsed) {
      this.element.dataset.consoleTarget =
        `${parsed.target.kind}:${parsed.target.sandboxId}`;
    } else delete this.element.dataset.consoleTarget;
    if (!this.#enabled) {
      this.#detach();
      this.#setStatus(
        parsed
          ? "Start the sandbox to open a terminal"
          : "Terminal configuration is invalid",
        "unavailable",
      );
    } else this.#start();
    this.#controls();
  }

  setActive(active: boolean): void {
    if (this.#active === active) return;
    this.#active = active;
    if (active) this.#start();
    else {
      this.#initialized = false;
      this.#fullscreen(false);
      this.#detach();
    }
    this.#controls();
  }

  #canConnect(): boolean {
    return this.#enabled && this.#active && !this.#disposed &&
      !this.#pageHidden && navigator.onLine;
  }
  #start(): void {
    if (!this.#canConnect()) return;
    if (!this.#initialized || !this.#selected) {
      void this.#run(async () => {
        await this.#refresh();
        this.#initialized = this.#canConnect();
      });
    } else void this.#connect();
  }

  async #run(action: () => Promise<void>): Promise<void> {
    if (this.#busy || !this.#canConnect()) return;
    this.#busy = true;
    const operations = this.#operations;
    this.#controls();
    try {
      await action();
    } catch (error) {
      if (
        !this.#disposed && this.#operations === operations &&
        !operations.signal.aborted
      ) {
        this.#setStatus(errorMessage(error), "error");
      }
    } finally {
      if (this.#operations === operations) {
        this.#busy = false;
        this.#controls();
      }
    }
  }

  async #post(path: string, value: unknown): Promise<unknown> {
    const signal = this.#operations.signal;
    const response = await fetch(`${TERMINAL_SERVICE}/${path}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
      signal,
    });
    await requireOK(response);
    const body = await readJSON(response, 4 << 20);
    signal.throwIfAborted();
    return body;
  }

  async #loadItems(): Promise<void> {
    const config = this.#configuration;
    if (!config) return;
    this.#detach();
    this.#setStatus("Loading terminals…", "connecting");
    const result = object(
      await this.#post("list", {
        targetKind: config.target.kind,
        targetSandboxId: config.target.sandboxId,
      }),
    );
    if (!Array.isArray(result.terminals) || result.terminals.length > 257) {
      throw new Error("Invalid terminal list");
    }
    this.#items = result.terminals.map(terminalItem);
  }

  async #refresh(): Promise<void> {
    await this.#loadItems();
    const remembered = this.#selected?.id ?? stored(this.#storageKey);
    const id = remembered && SESSION_ID.test(remembered)
      ? remembered
      : this.#items[0]?.id ?? "1";
    this.#choose(
      this.#items.find((item) => item.id === id) ?? this.#newItem(id),
    );
    await this.#connect();
  }

  #newItem(id: string): TerminalItem {
    if (!SESSION_ID.test(id)) {
      throw new Error("Terminal session IDs are limited to 40 characters");
    }
    const item = { id, name: `Terminal ${id}`, terminalId: "", route: "" };
    this.#items.push(item);
    return item;
  }

  async #create(): Promise<void> {
    await this.#loadItems();
    const next = this.#items.reduce(
      (maximum, item) =>
        /^\d+$/.test(item.id) && BigInt(item.id) > maximum
          ? BigInt(item.id)
          : maximum,
      0n,
    ) + 1n;
    this.#choose(this.#newItem(String(next)));
    await this.#connect();
  }

  #choose(item: TerminalItem | undefined): void {
    if (item?.id !== this.#selected?.id) {
      this.#detach();
      // The ordered snapshot installation clears the old display. Resetting
      // here would race a previous connection's pending xterm write callback.
      this.#setStatus("Loading terminal…", "connecting");
      this.#uncertainInput = false;
    }
    this.#selected = item;
    this.#select.replaceChildren(
      ...this.#items.map((item) =>
        new Option(`[${item.id}] ${item.name}`, item.id)
      ),
    );
    this.#select.value = item?.id ?? "";
    if (item) {
      save(this.#storageKey, item.id);
      this.element.dataset.terminalId = item.id;
    } else delete this.element.dataset.terminalId;
    this.#takeover.hidden = true;
    this.#controls();
  }

  async #edit(mode: "rename" | "close"): Promise<void> {
    const item = this.#selected;
    if (!item || this.#busy || !this.#canConnect()) return;
    const value = await this.#dialog(mode, item.name);
    if (value === undefined || this.#selected?.id !== item.id) return;
    await this.#run(async () => {
      if (mode === "rename") {
        await this.#post("rename", {
          terminalId: item.terminalId,
          name: value,
        });
        item.name = value;
        this.#choose(item);
      } else {
        await this.#post("close", { terminalId: item.terminalId });
        this.#items = this.#items.filter((candidate) =>
          candidate.id !== item.id
        );
        this.#choose(this.#items[0]);
        if (this.#selected) await this.#connect();
        else this.#setStatus("No terminals. Select New to open one.", "empty");
      }
    });
  }

  #dialog(mode: "rename" | "close", name: string): Promise<string | undefined> {
    const dialog = document.createElement("dialog");
    dialog.className = "sandbox-terminal-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const label = document.createElement("label");
    label.textContent = mode === "rename" ? "Terminal name" : `Close ${name}?`;
    const input = document.createElement("input");
    input.value = name;
    input.required = true;
    input.maxLength = 80;
    if (mode === "rename") label.append(input);
    const details = document.createElement("p");
    details.textContent = mode === "close"
      ? "Running commands in this terminal will stop."
      : "";
    const actions = document.createElement("div");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const accept = document.createElement("button");
    accept.type = "submit";
    accept.textContent = mode === "rename" ? "Save" : "Close terminal";
    actions.append(cancel, accept);
    form.append(label, details, actions);
    dialog.append(form);
    this.element.append(dialog);
    return new Promise((resolve) => {
      let result: string | undefined;
      const abort = () => dialog.close();
      this.#lifetime.signal.addEventListener("abort", abort, { once: true });
      cancel.onclick = () => dialog.close();
      form.onsubmit = (event) => {
        event.preventDefault();
        if (input.value.trim()) {
          result = input.value.trim();
          dialog.close();
        }
      };
      dialog.onclose = () => {
        this.#lifetime.signal.removeEventListener("abort", abort);
        dialog.remove();
        resolve(result);
      };
      dialog.showModal();
      if (mode === "rename") {
        input.focus();
        input.select();
      }
    });
  }

  async #connect(takeover = false): Promise<void> {
    const item = this.#selected;
    if (
      !this.#canConnect() || !item || this.#connection || this.#connecting ||
      this.#reconnect
    ) return;
    this.#connecting = true;
    const epoch = ++this.#connectEpoch;
    this.#setStatus("Connecting terminal…", "connecting");
    try {
      const config = this.#configuration!;
      const opened = terminalItem(
        object(
          await this.#post("open", {
            targetKind: config.target.kind,
            targetSandboxId: config.target.sandboxId,
            sessionId: item.id,
            arguments: config.arguments,
            environment: config.environment,
            workingDir: config.workingDirectory,
            size: this.#size(),
          }),
        ).terminal,
      );
      if (epoch !== this.#connectEpoch || !this.#canConnect()) return;
      this.#items = this.#items.map((candidate) =>
        candidate.id === opened.id ? opened : candidate
      );
      this.#choose(opened);
      const url = this.#url("connect");
      url.searchParams.set("route", opened.route);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, TERMINAL_PROTOCOL);
      socket.binaryType = "arraybuffer";
      const connection: Connection = {
        socket,
        abort: new AbortController(),
        ordered: Promise.resolve(),
        queuedBytes: 0,
        queuedFrames: 0,
        sequence: 0,
        ready: false,
        exited: false,
        input: [],
        inputBytes: 0,
        awaitingPong: false,
        stopped: false,
      };
      this.#connection = connection;
      socket.onopen = () => {
        if (this.#connection !== connection) return;
        this.#send(connection, {
          type: "attach",
          clientId: this.#clientId,
          takeover,
        });
        this.#heartbeat(connection);
      };
      socket.onmessage = (event) => this.#receive(connection, event.data);
      socket.onerror = () => socket.close();
      socket.onclose = (event) => {
        if (this.#connection !== connection) return;
        const stopped = connection.stopped || event.code === 1000 ||
          event.code === 1002 || event.code === 1008;
        this.#detach();
        if (stopped) {
          this.#setStatus(
            event.reason || "Terminal disconnected",
            "disconnected",
          );
        } else this.#retry();
      };
    } catch (error) {
      if (epoch !== this.#connectEpoch) return;
      this.#setStatus(errorMessage(error), "error");
      if (
        !(error instanceof RequestError) ||
        ![401, 403, 400].includes(error.status)
      ) this.#retry(`${errorMessage(error)} Reconnecting…`);
    } finally {
      if (epoch === this.#connectEpoch) this.#connecting = false;
    }
  }

  #receive(connection: Connection, data: unknown): void {
    if (this.#connection !== connection) return;
    const bytes = typeof data === "string"
      ? data.length * 2
      : data instanceof ArrayBuffer
      ? data.byteLength
      : Infinity;
    if (typeof data === "string") {
      try {
        if (data.length > 4096) throw new Error("Invalid terminal message");
        const message = object(JSON.parse(data));
        // A final notice must survive close even while display recovery or an
        // xterm write is pending. Stop the connection and its queued output now.
        if (message.type === "error") {
          connection.stopped = true;
          this.#takeover.hidden = message.busy !== true;
          this.#setStatus(
            typeof message.message === "string"
              ? message.message.slice(0, 500)
              : "Terminal is unavailable",
            "error",
          );
          this.#detach();
          return;
        }
        data = message;
      } catch (error) {
        this.#fail(connection, errorMessage(error));
        return;
      }
    }
    if (
      bytes > 65_544 || (connection.queuedBytes += bytes) > VIEW_QUEUE_BYTES ||
      ++connection.queuedFrames > VIEW_QUEUE_FRAMES
    ) {
      this.#fail(connection, "Terminal output exceeded the connection limit");
      return;
    }
    connection.ordered = connection.ordered.then(async () => {
      if (this.#connection !== connection) return;
      await this.#message(connection, data);
    }).catch((error) => {
      if (this.#connection === connection) {
        this.#fail(connection, errorMessage(error));
      }
    })
      .finally(() => {
        connection.queuedBytes -= bytes;
        connection.queuedFrames--;
      });
  }

  async #message(connection: Connection, data: unknown): Promise<void> {
    if (data instanceof ArrayBuffer) {
      const frame = new Uint8Array(data);
      const sequence = outputSequence(frame);
      this.#sequence(connection, sequence);
      await this.#changeDisplay(
        connection,
        () =>
          new Promise<void>((resolve) =>
            this.#terminal.write(frame.subarray(8), resolve)
          ),
      );
      this.#ack(connection, sequence);
      return;
    }
    const message = object(data);
    switch (message.type) {
      case "snapshot": {
        if (
          typeof message.viewId !== "string" || message.viewId.length > 80 ||
          connection.ready
        ) throw new Error("Invalid terminal recovery request");
        this.#setStatus("Restoring terminal…", "recovering");
        const url = this.#url("snapshot");
        url.searchParams.set("view", message.viewId);
        const response = await fetch(url, {
          headers: { "the8020-route": this.#selected!.route },
          credentials: "same-origin",
          cache: "no-store",
          signal: connection.abort.signal,
        });
        await requireOK(response);
        const sequence = Number(response.headers.get("x-terminal-sequence"));
        const bytes = Number(response.headers.get("x-terminal-bytes"));
        if (
          !Number.isSafeInteger(sequence) || sequence < 0 ||
          !Number.isSafeInteger(bytes) || bytes < 1 ||
          bytes > MAX_SNAPSHOT_BYTES
        ) throw new Error("Invalid terminal snapshot boundary");
        const snapshot = await readJSON(response, bytes);
        if (this.#connection !== connection) return;
        await this.#changeDisplay(
          connection,
          () => restoreTerminal(this.#terminal, snapshot),
        );
        connection.sequence = sequence;
        this.element.dataset.outputSequence = String(sequence);
        this.#send(connection, { type: "ready", sequence });
        break;
      }
      case "ready":
        connection.ready = true;
        this.#takeover.hidden = true;
        this.#retryDelay = 250;
        this.#state(connection, message);
        this.#resize();
        break;
      case "resize": {
        const size = terminalSize(message.size);
        const sequence = Number(message.sequence);
        this.#sequence(connection, sequence);
        await this.#changeDisplay(connection, () => {
          this.#terminal.options.scrollback = retainedScrollback(
            size.columns,
            size.rows,
          );
          this.#terminal.resize(size.columns, size.rows);
        });
        this.#ack(connection, sequence);
        break;
      }
      case "resize-ack":
        connection.resize = undefined;
        this.#resize();
        break;
      case "input-ack":
        if (!connection.inFlight) {
          throw new Error("Unexpected terminal input acknowledgement");
        }
        connection.inputBytes -= connection.inFlight.byteLength;
        connection.inFlight = undefined;
        this.#flushInput(connection);
        break;
      case "state":
        this.#state(connection, message);
        break;
      case "pong":
        connection.awaitingPong = false;
        break;
      default:
        throw new Error("Unknown terminal message");
    }
  }

  #changeDisplay(
    connection: Connection,
    action: () => void | Promise<void>,
  ): Promise<void> {
    const next = this.#display.then(() => {
      if (this.#connection === connection && !this.#disposed) return action();
    });
    this.#display = next.then(() => {}, () => {});
    return next;
  }

  #sequence(connection: Connection, sequence: number): void {
    if (
      !connection.ready || !Number.isSafeInteger(sequence) ||
      sequence !== connection.sequence + 1
    ) throw new Error("Terminal output sequence was lost");
    connection.sequence = sequence;
  }
  #ack(connection: Connection, sequence: number): void {
    if (this.#connection !== connection) return;
    this.element.dataset.outputSequence = String(sequence);
    this.#send(connection, { type: "ack", sequence });
  }
  #state(connection: Connection, message: Record<string, unknown>): void {
    connection.exited = message.exited === true;
    this.#setStatus(
      connection.exited
        ? `Process exited${
          typeof message.exitStatus === "number"
            ? ` (${message.exitStatus})`
            : ""
        }`
        : this.#uncertainInput
        ? "Connected. Check your last input before continuing."
        : message.displayReset === true
        ? "Terminal connected. Display restarted."
        : "Terminal connected",
      connection.exited ? "exited" : "connected",
    );
    this.#controls();
  }
  #send(
    connection: Connection,
    message: Record<string, unknown> | Uint8Array<ArrayBuffer>,
  ): void {
    if (
      this.#connection !== connection ||
      connection.socket.readyState !== WebSocket.OPEN
    ) return;
    try {
      connection.socket.send(
        message instanceof Uint8Array ? message : JSON.stringify(message),
      );
    } catch {
      this.#detach();
      this.#retry();
    }
  }

  #input(value: string, binary = false): void {
    const connection = this.#connection;
    if (
      !this.#canConnect() || !connection?.ready || connection.exited ||
      !value.length
    ) return;
    const available = VIEW_QUEUE_BYTES - connection.inputBytes;
    const full = () => {
      this.#setStatus(
        "Input buffer is full. Wait for the terminal or paste a smaller amount.",
        "connected",
      );
    };
    // UTF-16 length is a lower bound on UTF-8 bytes. Reject before allocating,
    // then encode into the remaining budget so a large paste stays bounded.
    if (value.length > available) {
      full();
      return;
    }
    let data: Uint8Array<ArrayBuffer>;
    if (binary) {
      data = Uint8Array.from(value, (character) => character.charCodeAt(0));
    } else {
      const buffer = new Uint8Array(Math.min(available, value.length * 3));
      const { read, written } = new TextEncoder().encodeInto(value, buffer);
      if (read !== value.length) {
        full();
        return;
      }
      data = buffer.subarray(0, written);
    }
    if (
      connection.input.length + (connection.inFlight ? 1 : 0) +
          Math.ceil(data.byteLength / 65_536) > VIEW_QUEUE_FRAMES
    ) {
      full();
      return;
    }
    this.#uncertainInput = false;
    connection.inputBytes += data.byteLength;
    for (let offset = 0; offset < data.byteLength; offset += 65_536) {
      connection.input.push(data.subarray(offset, offset + 65_536));
    }
    this.#flushInput(connection);
  }
  #flushInput(connection: Connection): void {
    if (
      connection.inFlight || !connection.ready ||
      this.#connection !== connection
    ) return;
    const data = connection.input.shift();
    if (!data) return;
    connection.inFlight = data;
    this.#send(connection, data);
  }
  #size(): Size {
    const proposed = this.#fit.proposeDimensions();
    return {
      columns: Math.max(2, Math.min(500, proposed?.cols ?? 80)),
      rows: Math.max(1, Math.min(200, proposed?.rows ?? 24)),
    };
  }
  #resize(): void {
    const connection = this.#connection;
    if (
      !this.#canConnect() || !connection?.ready || connection.exited ||
      connection.resize || !this.element.isConnected ||
      this.#viewport.clientWidth === 0
    ) return;
    const size = this.#size();
    const last = connection.lastResize ??
      { columns: this.#terminal.cols, rows: this.#terminal.rows };
    if (size.columns === last.columns && size.rows === last.rows) return;
    connection.resize = connection.lastResize = size;
    this.#send(connection, { type: "resize", size });
  }
  #heartbeat(connection: Connection): void {
    connection.heartbeat = setTimeout(() => {
      if (this.#connection !== connection) return;
      if (connection.awaitingPong) {
        this.#detach();
        this.#retry();
        return;
      }
      connection.awaitingPong = true;
      this.#send(connection, { type: "ping" });
      this.#heartbeat(connection);
    }, 15_000);
  }
  #fail(connection: Connection, message: string): void {
    connection.stopped = true;
    this.#setStatus(message, "error");
    this.#detach();
  }
  #retry(message = "Terminal disconnected; reconnecting…"): void {
    if (!this.#canConnect() || this.#reconnect) return;
    this.#setStatus(message, "disconnected");
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      void this.#connect();
    }, this.#retryDelay);
    this.#retryDelay = Math.min(10_000, this.#retryDelay * 2);
  }
  #detach(): void {
    ++this.#connectEpoch;
    this.#connecting = false;
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection) {
      this.#uncertainInput ||= connection.inputBytes > 0;
      connection.abort.abort();
      if (connection.heartbeat) clearTimeout(connection.heartbeat);
      connection.input.length = 0;
      connection.inputBytes = 0;
      connection.inFlight = undefined;
      connection.socket.close(1000, "Terminal view detached");
    }
    this.#terminal.options.disableStdin = true;
  }
  #url(path: string): URL {
    return new URL(`${TERMINAL_SERVICE}/${path}`, location.href);
  }
  #setStatus(message: string, state: string): void {
    this.#status.textContent = message;
    this.#status.title = message;
    this.element.dataset.terminalState = state;
    this.#loading.hidden = state === "connected" || state === "exited";
    this.#loadingMessage.textContent = state === "connecting"
      ? "Loading…"
      : message;
    if (
      state === "connecting" || state === "recovering" || state === "connected"
    ) {
      this.#takeover.hidden = true;
    }
    this.#viewport.setAttribute("aria-busy", String(state === "connecting"));
  }
  #fullscreen(enabled: boolean): void {
    this.element.classList.toggle("uui-content-fullscreen", enabled);
    const button = this.element.querySelector<HTMLButtonElement>(
      '[data-terminal-action="fullscreen"]',
    )!;
    button.title = enabled ? "Exit fullscreen" : "Fullscreen";
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(enabled));
    this.renderText(
      button,
      `[[icon=${enabled ? "fullscreen_exit" : "fullscreen"}]]`,
    );
  }
  #controls(): void {
    const enabled = this.#canConnect() && !this.#busy;
    this.#select.disabled = !enabled || !this.#items.length;
    for (
      const button of this.element.querySelectorAll<HTMLButtonElement>(
        ".sandbox-console-toolbar button, .sandbox-console-loading button",
      )
    ) {
      if (button.dataset.terminalAction === "fullscreen") {
        button.disabled = !this.#active;
        continue;
      }
      button.disabled = !enabled ||
        (["rename", "close", "takeover"].includes(
          button.dataset.terminalAction!,
        ) && !this.#selected?.terminalId);
    }
    this.#terminal.options.disableStdin = !this.#canConnect() ||
      !this.#connection?.ready || this.#connection.exited;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#detach();
    this.#operations.abort();
    this.#lifetime.abort();
    this.#observer.disconnect();
    this.#terminal.dispose();
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid terminal response");
  }
  return value as Record<string, unknown>;
}
function terminalItem(value: unknown): TerminalItem {
  const item = object(value);
  if (
    typeof item.id !== "string" || !SESSION_ID.test(item.id) ||
    typeof item.terminalId !== "string" ||
    !/^tty-[a-z0-9]{10}$/.test(item.terminalId) ||
    typeof item.name !== "string" || item.name.length > 80 ||
    typeof item.route !== "string" || item.route.length > 8192
  ) throw new Error("Invalid terminal record");
  return {
    id: item.id,
    terminalId: item.terminalId,
    name: item.name,
    route: item.route,
  };
}
function terminalSize(value: unknown): Size {
  const size = object(value);
  if (
    typeof size.columns !== "number" || !Number.isSafeInteger(size.columns) ||
    size.columns < 2 || size.columns > 500 || typeof size.rows !== "number" ||
    !Number.isSafeInteger(size.rows) || size.rows < 1 || size.rows > 200
  ) throw new Error("Invalid terminal dimensions");
  return { columns: size.columns, rows: size.rows };
}
function configuration(
  value: Record<string, unknown>,
): Configuration | undefined {
  try {
    const target = object(value.target);
    if (
      !["development", "runtime"].includes(String(target.kind)) ||
      typeof target.sandboxId !== "string" ||
      !/^sbx-[a-z0-9]{10}$/.test(target.sandboxId) ||
      !Array.isArray(value.arguments) || !value.arguments.length ||
      !value.arguments.every((item) => typeof item === "string") ||
      !Array.isArray(value.environment) || !value.environment.every((item) =>
        typeof item === "string"
      ) || typeof value.workingDirectory !== "string"
    ) return undefined;
    return {
      target: {
        kind: target.kind as Configuration["target"]["kind"],
        sandboxId: target.sandboxId,
      },
      arguments: value.arguments,
      environment: value.environment,
      workingDirectory: value.workingDirectory,
    };
  } catch {
    return undefined;
  }
}
function stored(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function save(key: string, value: string): void {
  try {
    if (key) sessionStorage.setItem(key, value);
  } catch { /* Selection still works when browser storage is disabled. */ }
}
function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
async function requireOK(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel();
  const message = response.status === 401
    ? "Sign in to reconnect to your terminal."
    : [404, 409].includes(response.status)
    ? "Terminal is unavailable. You can close it or create a new one."
    : response.status === 403
    ? "Terminal access was denied."
    : `Terminal request failed (${response.status}).`;
  throw new RequestError(response.status, message);
}
async function readJSON(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Terminal response is empty");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        throw new Error("Terminal response exceeds its size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
