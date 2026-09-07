import { assert, assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";

const bytes = 2 << 20;
const samples = 3;
const idleCount = 8;
const payload = "/tmp/8020-terminal-benchmark-output";
const completed = "/tmp/8020-terminal-benchmark-completed";
const script = `stty -echo; printf '\\036BENCH_READY\\037';
while IFS= read -r ticket; do
  printf '\\036BEGIN:%s\\037' "$ticket";
  cat ${payload}; printf '\\036DONE:%s\\037' "$ticket";
  printf '%s' "$ticket" > ${completed};
done`;

/** Real native transport measurements; the receiver deliberately excludes canvas paint. */
export default async function benchmark(context: NativeBrowserFixtureContext) {
  const { page, admin, credentials } = context;
  await admin(["dev-core.sandbox.create", credentials.username]);
  await admin(["dev-core.sandbox.start", credentials.username]);
  const listing = await admin(["dev-core.sandbox.list"]);
  const sandbox =
    (listing.sandboxes as { user_id: string; sandbox_id: string }[])
      .find((value) => value.user_id === credentials.username);
  assert(sandbox, "disposable development sandbox");
  await admin([
    "dev-core.sandbox.shell",
    credentials.username,
    "--command",
    `head -c ${bytes} /dev/zero | tr '\\0' x > ${payload}`,
  ]);
  const kernelStatus = await admin(["kernel.status"]);
  const kernelPID = Number(kernelStatus.pid);
  assert(
    Number.isSafeInteger(kernelPID) && kernelPID > 1,
    "fixture kernel PID",
  );
  const clock = Number(
    new TextDecoder().decode(
      (await new Deno.Command(
        "getconf",
        { args: ["CLK_TCK"] },
      ).output()).stdout,
    ).trim(),
  );
  assert(clock > 0);
  await page.evaluate(
    `globalThis.terminalBenchmark=(${browserDriver.toString()})()`,
  );
  const call = <T>(method: string, ...args: unknown[]): Promise<T> =>
    page.evaluate<T>(`terminalBenchmark.${method}(...${JSON.stringify(args)})`);
  const report: Record<string, unknown> = {
    recordedAt: new Date().toISOString(),
    workload: {
      bytes,
      samples,
      idleCount,
      columns: 80,
      rows: 24,
      scrollback: 5000,
    },
    versions: {
      deno: Deno.version,
      browser: await page.command("Browser.getVersion"),
    },
    scope:
      "Native gVisor PTY through authenticated browser transport; retained includes canonical xterm and snapshot parsing. Receiver counts bytes without canvas paint. CPU and RSS/PSS sum the fixture kernel and its descendants, excluding Chromium and the test driver; shared sandbox startup is warmed before comparison.",
    measurements: [],
  };
  const measurements = report.measurements as Record<string, unknown>[];
  try {
    for (const mode of ["direct", "retained"] as const) {
      const open = () => call<string>("open", mode, sandbox.sandbox_id, script);
      // Warm the native sandbox and, for retained, the ordinary service Worker.
      const warm = await open();
      await call("run", warm, "warm");
      await call("close", warm);
      const baseline = await sampleProcesses(kernelPID, clock);
      const ids: string[] = [];
      try {
        for (let i = 0; i < idleCount; i++) ids.push(await open());
        const idle = await sampleProcesses(kernelPID, clock);
        const idleCPUStart = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const idleEnd = await sampleProcesses(kernelPID, clock);
        const idleCPU = delta(idle, idleEnd);
        measurements.push({
          mode,
          operation: "eight-idle",
          baseline,
          idle,
          marginalRSSPerTerminal: (idle.rssBytes - baseline.rssBytes) /
            idleCount,
          marginalPSSPerTerminal: (idle.pssBytes - baseline.pssBytes) /
            idleCount,
          cpuSeconds: idleCPU.cpuSeconds,
          wallSeconds: (performance.now() - idleCPUStart) / 1000,
        });
        console.log(JSON.stringify({
          mode,
          operation: "eight-idle",
          marginalRSSPerTerminal: (idle.rssBytes - baseline.rssBytes) /
            idleCount,
          marginalPSSPerTerminal: (idle.pssBytes - baseline.pssBytes) /
            idleCount,
          cpuSeconds: idleCPU.cpuSeconds,
        }));
        const id = ids[0]!;
        for (let trial = 0; trial < samples; trial++) {
          const before = await sampleProcesses(kernelPID, clock);
          const result = await call<
            { elapsedMs: number; payloadBytes: number }
          >(
            "run",
            id,
            `${mode}-${trial}`,
          );
          const after = await sampleProcesses(kernelPID, clock);
          assertEquals(result.payloadBytes, bytes, "byte-exact native payload");
          const measurement = {
            mode,
            operation: "throughput",
            trial,
            ...result,
            MiBPerSecond: bytes / (1 << 20) / (result.elapsedMs / 1000),
            ...delta(before, after),
          };
          measurements.push(measurement);
          console.log(JSON.stringify(measurement));
        }
        for (let trial = 0; trial < samples; trial++) {
          const result = await call("reconnect", id);
          measurements.push({ mode, operation: "reconnect", trial, result });
          console.log(
            JSON.stringify({ mode, operation: "reconnect", trial, result }),
          );
        }
        if (mode === "retained") {
          await call("stall", id, "stalled");
          await context.waitForPage(
            page,
            `terminalBenchmark.closed(${JSON.stringify(id)})`,
            "slow view detached",
            30_000,
          );
          const result = await admin([
            "dev-core.sandbox.shell",
            credentials.username,
            "--command",
            `timeout 30 bash -c 'while [ "$(cat ${completed})" != stalled ]; do sleep 0.05; done'; cat ${completed}`,
          ]);
          assertEquals(
            (result.shell as { output: string }).output,
            "stalled",
            "producer finishes after slow view detaches",
          );
          measurements.push({
            mode,
            operation: "slow-view",
            producerCompleted: true,
            resources: await sampleProcesses(kernelPID, clock),
          });
          await call("reconnect", id);
          const resultAfterStall = await call<{ payloadBytes: number }>(
            "run",
            id,
            "after-stall",
          );
          assertEquals(
            resultAfterStall.payloadBytes,
            bytes,
            "same process continues after slow view",
          );
        }
      } finally {
        for (const id of ids) await call("close", id);
      }
    }
    report.passed = true;
  } finally {
    const destination = Deno.env.get("THE8020_TERMINAL_BENCHMARK_REPORT") ??
      "/tmp/8020-terminal-native-performance.json";
    await Deno.writeTextFile(
      destination,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    console.log(`Native terminal performance measurements: ${destination}`);
  }
}

interface ProcessSample {
  cpuSeconds: number;
  rssBytes: number;
  pssBytes: number;
  processes: Record<string, number>;
}

async function sampleProcesses(
  rootPID: number,
  clock: number,
): Promise<ProcessSample> {
  const result: ProcessSample = {
    cpuSeconds: 0,
    rssBytes: 0,
    pssBytes: 0,
    processes: {},
  };
  const pending = [rootPID], visited = new Set<number>();
  while (pending.length) {
    const pid = pending.pop()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    assert(visited.size <= 2048, "bounded disposable process tree");
    try {
      const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") continue;
      const cpu = (Number(fields[11]) + Number(fields[12])) / clock;
      result.processes[`${pid}:${fields[19]}`] = cpu;
      result.cpuSeconds += cpu;
      const memory = await Deno.readTextFile(`/proc/${pid}/smaps_rollup`);
      result.rssBytes += Number(/^Rss:\s+(\d+)/m.exec(memory)?.[1] ?? 0) * 1024;
      result.pssBytes += Number(/^Pss:\s+(\d+)/m.exec(memory)?.[1] ?? 0) * 1024;
      for await (const task of Deno.readDir(`/proc/${pid}/task`)) {
        const children = await Deno.readTextFile(
          `/proc/${pid}/task/${task.name}/children`,
        );
        for (const child of children.trim().split(/\s+/)) {
          if (child) pending.push(Number(child));
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return result;
}

function delta(before: ProcessSample, after: ProcessSample) {
  let cpuSeconds = 0;
  for (const [process, value] of Object.entries(after.processes)) {
    cpuSeconds += value - (before.processes[process] ?? 0);
  }
  return { cpuSeconds, rssBytes: after.rssBytes, pssBytes: after.pssBytes };
}

/** Serialized into the already authenticated Chromium page; no production instrumentation. */
export function browserDriver() {
  const service = "/the8020/dev-core/terminals";
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  interface View {
    mode: string;
    sandboxId: string;
    script: string;
    terminal?: { id: string; route: string };
    socket?: WebSocket;
    ready?: Promise<void>;
    tail: string;
    payloadBytes: number;
    started: number;
    ack: boolean;
    counting?: boolean;
    done?: {
      ticket: string;
      resolve(value: unknown): void;
      reject(error: Error): void;
    };
    readyResolve?: () => void;
    readyReject?: (error: Error) => void;
    snapshotBytes?: number;
    snapshotMs?: number;
  }
  const views = new Map<string, View>();
  async function post(path: string, body: unknown) {
    const response = await fetch(`${service}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${path}: ${response.status}: ${await response.text()}`);
    }
    return await response.json();
  }
  async function connect(view: View) {
    const start = performance.now();
    view.ack = true;
    view.ready = new Promise((resolve, reject) => {
      view.readyResolve = resolve;
      view.readyReject = reject;
    });
    const path = view.mode === "direct"
      ? "/_the8020/console"
      : `${service}/connect?route=${encodeURIComponent(view.terminal!.route)}`;
    const socket = new WebSocket(
      `${location.origin.replace(/^http/, "ws")}${path}`,
      view.mode === "direct" ? "the8020.console.v1" : "the8020.terminal.v1",
    );
    view.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () =>
      socket.send(JSON.stringify(
        view.mode === "direct"
          ? {
            type: "open",
            target: { kind: "development", sandboxId: view.sandboxId },
            arguments: [
              "/bin/bash",
              "--noprofile",
              "--norc",
              "-c",
              view.script,
            ],
            environment: ["TERM=xterm-256color"],
            workingDirectory: "/tmp",
            columns: 80,
            rows: 24,
          }
          : { type: "attach", clientId: "native-performance", takeover: false },
      ));
    const fail = (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      view.readyReject?.(failure);
      view.done?.reject(failure);
    };
    socket.onerror = () => fail(new Error("benchmark socket failed"));
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        const message = JSON.parse(event.data);
        if (message.type === "snapshot") {
          void (async () => {
            const started = performance.now();
            const response = await fetch(
              `${service}/snapshot?view=${encodeURIComponent(message.viewId)}`,
              { headers: { "the8020-route": view.terminal!.route } },
            );
            if (!response.ok) throw new Error(`snapshot ${response.status}`);
            const snapshot = await response.json();
            if (!snapshot || typeof snapshot !== "object") {
              throw new Error("invalid snapshot");
            }
            view.snapshotBytes = Number(
              response.headers.get("x-terminal-bytes"),
            );
            view.snapshotMs = performance.now() - started;
            socket.send(
              JSON.stringify({
                type: "ready",
                sequence: Number(response.headers.get("x-terminal-sequence")),
              }),
            );
          })().catch(fail);
        } else if (message.type === "ready") view.readyResolve?.();
        else if (message.type === "resize" && view.ack) {
          socket.send(
            JSON.stringify({ type: "ack", sequence: message.sequence }),
          );
        } else if (message.type === "error") fail(new Error(message.message));
        return;
      }
      const frame = new Uint8Array(event.data);
      const data = view.mode === "direct" ? frame : frame.subarray(8);
      const text = decoder.decode(data);
      let count = text;
      if (!view.counting) {
        const marker = `\x1eBEGIN:${view.done?.ticket}\x1f`;
        const joined = view.tail + text;
        const start = joined.indexOf(marker);
        count = start >= 0 ? joined.slice(start + marker.length) : "";
        if (start >= 0) view.counting = true;
      }
      for (let i = 0; i < count.length; i++) {
        if (count.charCodeAt(i) === 120) view.payloadBytes++;
      }
      view.tail = (view.tail + text).slice(-1024);
      if (view.mode === "direct" && view.tail.includes("\x1eBENCH_READY\x1f")) {
        view.readyResolve?.();
      }
      if (view.mode !== "direct" && view.ack) {
        socket.send(
          JSON.stringify({
            type: "ack",
            sequence: Number(new DataView(frame.buffer).getBigUint64(0)),
          }),
        );
      }
      if (view.done && view.tail.includes(`\x1eDONE:${view.done.ticket}\x1f`)) {
        view.done.resolve({
          elapsedMs: performance.now() - view.started,
          payloadBytes: view.payloadBytes,
        });
        view.done = undefined;
      }
    };
    await Promise.race([
      view.ready,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("terminal benchmark connection timeout")),
          30_000,
        );
        void view.ready!.then(
          () => clearTimeout(timer),
          () => clearTimeout(timer),
        );
      }),
    ]);
    return {
      elapsedMs: performance.now() - start,
      snapshotBytes: view.snapshotBytes,
      snapshotMs: view.snapshotMs,
      sameProcess: view.mode !== "direct",
    };
  }
  async function disconnect(view: View) {
    const socket = view.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.addEventListener("close", () => resolve(), { once: true });
      socket.close();
    });
  }
  return {
    terminal(id: string) {
      return views.get(id)!.terminal;
    },
    detach(id: string) {
      return disconnect(views.get(id)!);
    },
    async adopt(terminal: { id: string; route: string }) {
      const id = crypto.randomUUID();
      const view: View = {
        mode: "retained",
        sandboxId: "",
        script: "",
        terminal,
        tail: "",
        payloadBytes: 0,
        started: 0,
        ack: true,
      };
      views.set(id, view);
      await connect(view);
      return id;
    },
    async open(mode: string, sandboxId: string, script: string) {
      const id = crypto.randomUUID();
      const view: View = {
        mode,
        sandboxId,
        script,
        tail: "",
        payloadBytes: 0,
        started: 0,
        ack: true,
      };
      if (mode === "retained") {
        view.terminal = (await post("create", {
          targetKind: "development",
          targetSandboxId: sandboxId,
          name: "Native benchmark",
          arguments: ["/bin/bash", "--noprofile", "--norc", "-c", script],
          environment: ["TERM=xterm-256color"],
          workingDir: "/tmp",
          size: { columns: 80, rows: 24 },
        })).terminal;
      }
      views.set(id, view);
      await connect(view);
      return id;
    },
    run(id: string, ticket: string) {
      const view = views.get(id)!;
      view.tail = "";
      view.payloadBytes = 0;
      view.counting = false;
      view.started = performance.now();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`output timeout: ${ticket}`)),
          30_000,
        );
        view.done = {
          ticket,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        view.socket!.send(encoder.encode(`${ticket}\n`));
      });
    },
    async reconnect(id: string) {
      const view = views.get(id)!;
      await disconnect(view);
      view.tail = "";
      return await connect(view);
    },
    stall(id: string, ticket: string) {
      const view = views.get(id)!;
      view.ack = false;
      view.socket!.send(encoder.encode(`${ticket}\n`));
    },
    closed(id: string) {
      return views.get(id)!.socket!.readyState === WebSocket.CLOSED;
    },
    async close(id: string) {
      const view = views.get(id)!;
      await disconnect(view);
      if (view.terminal) await post("close", { terminalId: view.terminal.id });
      views.delete(id);
    },
  };
}
