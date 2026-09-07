import { assert, assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";
import { browserDriver } from "./native_performance_scenarios.ts";
import { SSHView } from "./native_ssh_scenarios.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Real kernel deadlines, browser/SSH leases, metadata cleanup and checkpoint restore. */
export default async function verify(context: NativeBrowserFixtureContext) {
  const { page, admin, credentials } = context;
  for (
    const [key, expected] of [["terminal.idle_timeout", "36h0m0s"], [
      "development.idle_timeout",
      "2h0m0s",
    ]]
  ) {
    const config = await admin(["kernel.config.get", key!]);
    assertEquals(
      (config.setting as { active_value: string }).active_value,
      expected,
    );
  }
  await admin(["kernel.config.set", "terminal.idle_timeout", "8s"]);
  const config = await admin(["kernel.config.get", "network.ssh_port"]);
  const port = (config.setting as { active_value: number }).active_value;
  const inspect = async () =>
    (await admin(["dev-core.sandbox.inspect", credentials.username]))
      .sandbox as { sandbox_id: string; state: string };
  const shell = async (command: string) =>
    (await admin([
      "dev-core.sandbox.shell",
      credentials.username,
      "--command",
      command,
    ])).shell as { output: string };
  const waitUntil = async (
    check: () => Promise<boolean>,
    description: string,
    timeout = 15_000,
  ) => {
    const end = Date.now() + timeout;
    while (!await check()) {
      assert(Date.now() < end, description);
      await delay(100);
    }
  };
  await admin(["dev-core.sandbox.create", credentials.username]);
  await admin(["dev-core.sandbox.start", credentials.username]);
  const sandbox = await inspect();
  await page.evaluate(
    `globalThis.terminalBenchmark=(${browserDriver.toString()})()`,
  );
  const script =
    "stty -echo; printf '%s' $$ > /tmp/8020-idle-pid; printf saved > /workspace/packages/the8020/demo/idle-private.txt; while :; do printf 'IDLE_PID:%s\\r\\n' \"$$\"; sleep 0.2; done";
  const id = await page.evaluate<string>(
    `terminalBenchmark.open('retained', ${
      JSON.stringify(sandbox.sandbox_id)
    }, ${JSON.stringify(script)})`,
  );
  const terminal = await page.evaluate<{ id: string; route: string }>(
    `terminalBenchmark.terminal(${JSON.stringify(id)})`,
  );
  const pid = (await shell("cat /tmp/8020-idle-pid")).output;
  assert(/^\d+$/.test(pid));
  // Start the short sandbox deadline after cold service/module initialization.
  await admin(["kernel.config.set", "development.idle_timeout", "2s"]);
  console.log(
    `Idle fixture attached ${terminal.id}, Bash PID ${pid}; deadlines 8s/2s`,
  );
  await delay(9_000);
  assertEquals(
    (await inspect()).state,
    "READY",
    "browser attachment protects both deadlines",
  );
  await page.evaluate(`terminalBenchmark.detach(${JSON.stringify(id)})`);
  await delay(3_000);
  assertEquals(
    (await inspect()).state,
    "READY",
    "detached retained terminal protects sandbox beyond 2s",
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const ssh = new SSHView(context, port, terminal.id);
    try {
      await ssh.contains(`IDLE_PID:${pid}`);
      await delay(attempt === 0 ? 9_000 : 1_000);
      assertEquals(
        (await inspect()).state,
        "READY",
        "SSH attachment cancels terminal expiry",
      );
    } finally {
      await ssh.close();
    }
    if (attempt === 0) await delay(3_000);
  }
  const detached = Date.now();
  const remaining = async () =>
    (await admin([
      "db.sql",
      `SELECT "terminalId" FROM "the8020__dev_core__terminals" WHERE "terminalId" = '${terminal.id}'`,
    ])).rows as unknown[];
  await waitUntil(
    async () => (await remaining()).length === 0,
    "kernel expiry must remove package metadata despite continuing PTY output",
  );
  assert(
    Date.now() - detached >= 7_500,
    "reattachment must restart the full terminal timeout",
  );
  assertEquals(
    (await inspect()).state,
    "READY",
    "sandbox timeout starts only after terminal destruction",
  );
  await waitUntil(
    async () => (await inspect()).state === "STOPPED",
    "sandbox must stop after the last retained terminal expires",
  );
  assert(
    Date.now() - detached >= 9_500,
    "sandbox must receive its additional 2s interval",
  );
  console.log(
    "Retained browser/SSH reattachment, output-independent 8s expiry, metadata cleanup and subsequent 2s sandbox stop passed",
  );

  // Ordinary SSH has connection lifetime and starts the same sandbox on demand.
  const ordinary = new SSHView(context, port);
  try {
    await ordinary.input("printf '\\nORDINARY_READY\\n'\r");
    await ordinary.contains("ORDINARY_READY");
    assertEquals(
      (await shell("cat /workspace/packages/the8020/demo/idle-private.txt"))
        .output,
      "saved",
      "idle stop checkpoints private workspace changes",
    );
    await delay(3_000);
    assertEquals(
      (await inspect()).state,
      "READY",
      "ordinary SSH protects sandbox while connected",
    );
  } finally {
    await ordinary.close();
  }
  await waitUntil(
    async () => (await inspect()).state === "STOPPED",
    "ordinary SSH disconnect must start the 2s timeout",
  );
  assertEquals(await remaining(), []);
  console.log(
    "Ordinary SSH connection lifetime and idle checkpoint restoration passed",
  );
}
