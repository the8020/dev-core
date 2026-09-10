import { assert, assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";
import { TerminalEngine } from "./engine.ts";

export async function verifyNativeNamedSessions(
  context: NativeBrowserFixtureContext,
): Promise<void> {
  const config = await context.admin(["kernel.config.get", "network.ssh_port"]);
  const port = (config.setting as { active_value: number }).active_value;
  const name = "N_-" + "a".repeat(37);
  let firstPID = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const ssh = new SSHView(context, port, name);
    try {
      await ssh.input("printf '\\n%s:%s\\n' NAMED_PID \"$$\"\r");
      await ssh.contains("\nNAMED_PID:");
      const pid = /\nNAMED_PID:(\d+)/.exec(ssh.text())?.[1];
      assert(pid);
      if (attempt === 0) firstPID = pid;
      else if (attempt === 1) {
        assertEquals(
          pid,
          firstPID,
          "named SSH reconnect preserves the process",
        );
      } else assert(pid !== firstPID, "named SSH recreates a killed process");
    } finally {
      await ssh.close();
    }
    if (attempt === 1) {
      await context.admin([
        "dev-core.sandbox.shell",
        context.credentials.username,
        "--command",
        `kill -KILL ${firstPID}`,
      ]);
    }
  }
  const rows = (await context.admin([
    "db.sql",
    `SELECT "terminalId" FROM "the8020__dev_core__terminals" WHERE "sessionId" = '${name}'`,
  ])).rows as string[][];
  assertEquals(rows.length, 1);
  await context.page.evaluate(
    `fetch('/the8020/dev-core/terminals/close', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({terminalId:${
      JSON.stringify(rows[0]![0])
    }})}).then(r=>{if(!r.ok)throw new Error('named session cleanup failed')})`,
  );
  console.log(
    "Native SSH creates, reconnects and recreates a 40-character named session",
  );
}

/** Real OpenSSH, users-package authentication, retained service, and native htop. */
export async function verifyNativeSSH(
  context: NativeBrowserFixtureContext,
  terminalId: string,
  htopPID: string,
): Promise<void> {
  const config = await context.admin(["kernel.config.get", "network.ssh_port"]);
  const port = (config.setting as { active_value: number }).active_value;
  for (let attachment = 0; attachment < 2; attachment++) {
    const ssh = new SSHView(context, port, terminalId);
    try {
      await ssh.contains("Tasks:");
      await ssh.contains(htopPID);
      await ssh.input("\x1bOQ"); // F2
      await ssh.contains("Display options");
      await ssh.input("\x1b");
      await ssh.absent("Display options");
      await ssh.input("\x1b[17~"); // F6
      await ssh.contains("Sort by");
      await ssh.input("\x1b");
      await ssh.absent("Sort by");
      await ssh.input("\x1bORhtop\x7fp"); // F3, search and editing
      await ssh.contains("htop");
      await ssh.input("\x1b\x1b[B\x1b[A\x1b[6~\x1b[5~");
      await ssh.contains("Tasks:");
      assertEquals(
        ssh.queryReplies,
        0,
        "SSH display must never solicit duplicate terminal replies",
      );
      console.log(
        `Native SSH attachment ${
          attachment + 1
        }: ${terminalId}, htop PID ${htopPID}, rendering and shortcuts passed`,
      );
    } finally {
      await ssh.close();
    }
  }
}

export async function verifyNativeSSHShell(
  context: NativeBrowserFixtureContext,
  terminalId: string,
  pid: string,
  reclaim: () => Promise<void>,
): Promise<void> {
  const config = await context.admin(["kernel.config.get", "network.ssh_port"]);
  const port = (config.setting as { active_value: number }).active_value;
  const ssh = new SSHView(context, port, terminalId);
  try {
    await ssh.contains("HTOP_DONE:");
    await ssh.input(
      'saved_modes=$(stty -g); stty -echo -icanon min 1 time 0; printf \'\\033[6n\'; IFS= read -r -s -d R -t 5 response; answered=$?; IFS= read -r -s -n 1 -t 0.3 extra; duplicate=$?; stty "$saved_modes"; printf \'\\r\\nSSH_QUERY:%s:%s:%s\\r\\n\' "$answered" "$duplicate" "$$"\r',
    );
    await ssh.contains(`SSH_QUERY:0:142:${pid}`);
    assertEquals(ssh.queryReplies, 0);
    // Advance a split application redraw through real SSH/PTY input. The view
    // must keep the composer cursor while the application paints rows above it.
    await ssh.input(
      "printf '\\033[?1049h\\033[2J\\033[HWorking\\033[24;3H'; read -r -s -n 1; printf '\\033[?2026h\\033[2;1HPartial redraw\\033[19;1H'; read -r -s -n 1; printf '\\033[2;1HComplete redraw\\033[24;3H\\033[?2026l'; read -r -s -n 1; printf '\\033[?1049l\\r\\nSSH_FRAME_DONE\\r\\n'\r",
    );
    await ssh.contains("Working");
    await ssh.input("a");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(!ssh.text().includes("Partial redraw"));
    assertEquals(ssh.engine.terminal.buffer.active.cursorY, 23);
    assertEquals(ssh.engine.terminal.buffer.active.cursorX, 2);
    await ssh.input("b");
    await ssh.contains("Complete redraw");
    assertEquals(ssh.engine.terminal.buffer.active.cursorY, 23);
    assertEquals(ssh.engine.terminal.buffer.active.cursorX, 2);
    assertEquals(ssh.engine.terminal.modes.synchronizedOutputMode, false);
    await ssh.input("c");
    await ssh.contains("SSH_FRAME_DONE");
    await reclaim();
    await Promise.race([
      ssh.child.status,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Browser takeover did not detach SSH")),
          10_000,
        );
        void ssh.child.status.then(() => clearTimeout(timer));
      }),
    ]);
    console.log(
      `Native SSH query answered once; browser reclaimed ${terminalId} with Bash PID ${pid}`,
    );
  } finally {
    await ssh.close();
  }
}

export class SSHView {
  readonly engine = new TerminalEngine({ columns: 80, rows: 24 });
  readonly child: Deno.ChildProcess;
  readonly #input: WritableStreamDefaultWriter<Uint8Array>;
  readonly #output: Promise<void>;
  readonly #errors: Promise<string>;
  #failure?: unknown;
  #sequence = 0;
  queryReplies = 0;

  constructor(
    context: NativeBrowserFixtureContext,
    port: number,
    terminalId?: string,
  ) {
    this.child = new Deno.Command("sshpass", {
      args: [
        "-e",
        "ssh",
        "-tt",
        "-p",
        String(port),
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `UserKnownHostsFile=${context.root}/ssh-test-known-hosts`,
        "-o",
        "PreferredAuthentications=password",
        "-o",
        "PubkeyAuthentication=no",
        `${context.credentials.username}@127.0.0.1`,
        ...(terminalId ? ["the8020", "terminal-id", terminalId] : []),
      ],
      env: { SSHPASS: context.credentials.password, TERM: "xterm-256color" },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#input = this.child.stdin.getWriter();
    this.#errors = new Response(this.child.stderr).text();
    const child = this.child, input = this.#input;
    this.#output = (async () => {
      try {
        for await (const data of child.stdout) {
          const reply = await this.engine.apply({
            sequence: ++this.#sequence,
            data,
          });
          if (reply) {
            this.queryReplies++;
            await input.write(reply);
          }
        }
      } catch (error) {
        this.#failure = error;
      }
    })();
  }

  input(text: string): Promise<void> {
    return this.#input.write(new TextEncoder().encode(text));
  }
  text(): string {
    const b = this.engine.terminal.buffer.active;
    return Array.from(
      { length: this.engine.terminal.rows },
      (_, y) => b.getLine(b.baseY + y)?.translateToString(true),
    ).join("\n");
  }
  contains(text: string): Promise<void> {
    return this.#wait(text, true);
  }
  absent(text: string): Promise<void> {
    return this.#wait(text, false);
  }
  async #wait(text: string, present: boolean): Promise<void> {
    const end = Date.now() + 20_000;
    while (this.text().includes(text) !== present) {
      if (this.#failure) throw this.#failure;
      assert(
        Date.now() < end,
        `SSH display ${
          present ? "missing" : "still contains"
        } ${text}: ${this.text()}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  async close(): Promise<void> {
    await this.#input.close().catch(() => {});
    const deadline = setTimeout(() => {
      try {
        this.child.kill("SIGKILL");
      } catch { /* Already exited. */ }
    }, 5000);
    try {
      await this.child.status;
      await this.#output;
      const errors = await this.#errors;
      if (this.#failure) throw new Error(`${String(this.#failure)}: ${errors}`);
    } finally {
      clearTimeout(deadline);
      await this.engine.close();
    }
  }
}
