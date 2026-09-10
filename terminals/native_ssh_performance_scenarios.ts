import { assert, assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";
import { SSHView } from "./native_ssh_scenarios.ts";

const bytes = Deno.env.get("THE8020_TERMINAL_BENCHMARK_SMALL") === "1"
  ? 128 << 10
  : 2 << 20;
const warmupBytes = 2 << 20;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Real OpenSSH including native projection and client parsing, without GUI paint. */
export default async function benchmark(context: NativeBrowserFixtureContext) {
  const shell = (command: string) =>
    context.admin([
      "dev-core.sandbox.shell",
      context.credentials.username,
      "--command",
      command,
    ]);
  await context.admin([
    "dev-core.sandbox.create",
    context.credentials.username,
  ]);
  await context.admin(["dev-core.sandbox.start", context.credentials.username]);
  await shell(`head -c ${bytes} /dev/zero | tr '\\0' x > /tmp/ssh-payload;
    mkdir -p /tmp/ssh-clicks/alpha /tmp/ssh-clicks/beta;
    (command -v mc && command -v python3) || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mc python3)`);
  const config = await context.admin(["kernel.config.get", "network.ssh_port"]);
  const port = (config.setting as { active_value: number }).active_value;
  const measurements: Record<string, unknown>[] = [];
  const report = {
    recordedAt: new Date().toISOString(),
    scope:
      "Loopback OpenSSH through real gVisor PTY; direct connection versus retained canonical interpreter and native projection. Includes client headless parsing, excludes Warp/browser GUI paint and WAN latency. Throughput uses source payload bytes; projected SSH bytes can differ. Latency ends at parsed acknowledgement, not the polling interval.",
    sourceBytes: bytes,
    warmupBytes,
    columns: 80,
    rows: 24,
    measurements,
    passed: false,
  };
  try {
    for (const mode of ["direct", "retained"] as const) {
      const ssh = new SSHView(
        context,
        port,
        mode === "retained" ? "ssh-bench" : undefined,
      );
      try {
        await ssh.input("stty -echo; printf '\\r\\nBENCH_READY\\r\\n'\r");
        await ssh.contains("\nBENCH_READY\n");
        for (let trial = -warmupBytes / bytes; trial < 3; trial++) {
          const marker = `PAYLOAD_DONE_${trial}`;
          const before = ssh.receivedBytes, start = performance.now();
          await ssh.input(
            `cat /tmp/ssh-payload; printf '\\r\\n${marker}\\r\\n'\r`,
          );
          await ssh.contains(`\n${marker}\n`);
          if (trial >= 0) {
            const elapsedMs = ssh.lastOutputAt - start;
            const measurement = {
              mode,
              operation: "throughput",
              trial,
              elapsedMs,
              MiBPerSecond: bytes / (1 << 20) / (elapsedMs / 1000),
              sshBytes: ssh.receivedBytes - before,
            };
            measurements.push(measurement);
            console.log(JSON.stringify(measurement));
          }
        }
        // Record exact input at the physical PTY while the application redraws
        // at 60 Hz. Acknowledgements include the input sequence and coordinates.
        const received = `/tmp/ssh-input-${mode}.json`;
        const probe = `import os,tty,time,threading,json
tty.setraw(0)
stop=threading.Event()
def draw():
 n=0
 while not stop.wait(1/60):
  os.write(1, ('\\x1b[?2026h\\x1b[3;1HREDRAW_%06d\\x1b[24;3H\\x1b[?2026l'%n).encode()); n+=1
t=threading.Thread(target=draw); t.start()
os.write(1,b'\\x1b[2J\\x1b[HINPUT_READY\\r\\n')
buffer=b''; records=[]
while len(records)<40:
 buffer+=os.read(0,4096)
 while b'\\n' in buffer:
  line,buffer=buffer.split(b'\\n',1)
  records.append({'input':line.decode(),'at':time.monotonic()})
  os.write(1,('\\x1b[2;1HACK_%02d'%len(records)).encode())
stop.set(); t.join()
open(${JSON.stringify(received)},'w').write(json.dumps(records))
os.write(1,b'\\r\\nINPUT_DONE\\r\\n')
`;
        await shell(`printf %s ${quote(probe)} > /tmp/ssh-input-probe.py`);
        await ssh.input("python3 /tmp/ssh-input-probe.py\r");
        await ssh.contains("INPUT_READY");
        const inputs: string[] = [],
          latency: number[] = [],
          sent: number[] = [];
        for (let i = 0; i < 40; i++) {
          const x = 5 + i % 20, y = 4 + i % 12;
          const input = `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
          inputs.push(input);
          const start = performance.now();
          sent.push(start);
          await ssh.input(input + "\n");
          await ssh.contains(`ACK_${String(i + 1).padStart(2, "0")}`);
          latency.push(ssh.lastOutputAt - start);
          await pause(25);
        }
        await ssh.contains("INPUT_DONE");
        const result = await shell(`cat ${received}`);
        const records = JSON.parse(
          (result.shell as { output: string }).output,
        ) as { input: string; at: number }[];
        assertEquals(
          records.map((r) => r.input),
          inputs,
          "each click pair reaches the physical PTY exactly once and in order",
        );
        const timingErrorMs = records.slice(1).map((r, i) =>
          Math.abs((r.at - records[i]!.at) * 1000 - (sent[i + 1]! - sent[i]!))
        );
        latency.sort((a, b) => a - b);
        measurements.push({
          mode,
          operation: "click-input-during-60hz-redraw",
          clickPairs: inputs.length,
          medianMs: latency[20],
          p95Ms: latency[37],
          maxMs: latency[39],
          maxIntervalErrorMs: Math.max(...timingErrorMs),
          exactInput: true,
        });
        console.log(JSON.stringify(measurements.at(-1)));
        await ssh.input("printf '\\033[?2026h\\r\\nFRAME_TIMEOUT\\r\\n'\r");
        await ssh.contains("\nFRAME_TIMEOUT\n");
        const resumed = performance.now();
        await ssh.input("printf '\\r\\nAFTER_TIMEOUT\\r\\n'\r");
        await ssh.contains("\nAFTER_TIMEOUT\n");
        const resumeMs = ssh.lastOutputAt - resumed;
        assert(
          resumeMs < 500,
          `ordinary output after redraw deadline took ${resumeMs} ms`,
        );
        measurements.push({
          mode,
          operation: "redraw-timeout-recovery",
          elapsedMs: resumeMs,
        });
        await ssh.input(
          "stty sane -echo; LC_ALL=C mc --nosubshell /tmp/ssh-clicks /tmp/ssh-clicks\r",
        );
        await ssh.contains("alpha");
        await ssh.contains("beta");
        const lines = ssh.text().split("\n"), menu = lines[0]!;
        const fileX = menu.indexOf("File") + 1;
        assert(fileX > 0, `MC File menu: ${menu}`);
        for (let x = fileX; x < fileX + 4; x++) {
          await ssh.input(`\x1b[<0;${x};1M\x1b[<0;${x};1m`);
          await ssh.contains("Chmod");
          await ssh.input("\x1b\x1b");
          await ssh.absent("Chmod");
          await pause(300);
        }
        const alphaY = lines.findIndex((l) => l.includes("alpha")) + 1;
        const betaY = lines.findIndex((l) => l.includes("beta")) + 1;
        assert(alphaY > 1 && betaY > alphaY);
        const click = (y: number) =>
          ssh.input(`\x1b[<0;5;${y}M\x1b[<0;5;${y}m`);
        await click(alphaY);
        await pause(350);
        await click(betaY);
        await pause(350);
        assert(
          !ssh.text().includes("/ssh-clicks/beta"),
          "separated clicks only select",
        );
        await click(alphaY);
        await pause(80);
        await click(betaY);
        await ssh.contains("/ssh-clicks/beta");
        measurements.push({
          mode,
          operation: "midnight-commander",
          fileMenuCells: 4,
          separatedClicksSelect: true,
          fastClicksOnDifferentRowsOpen: true,
        });
        console.log(JSON.stringify(measurements.at(-1)));
        await ssh.input("\x1b[21~"); // F10
        await ssh.input("exit\r");
      } finally {
        await ssh.close();
      }
    }
    report.passed = true;
  } finally {
    const path = Deno.env.get("THE8020_TERMINAL_BENCHMARK_REPORT") ??
      "/tmp/8020-terminal-ssh-performance.json";
    await Deno.writeTextFile(path, JSON.stringify(report, null, 2) + "\n");
    console.log(`SSH performance report: ${path}`);
  }
}
