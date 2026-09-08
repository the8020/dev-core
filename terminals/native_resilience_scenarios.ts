import { assert, assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";
import { browserDriver } from "./native_performance_scenarios.ts";

/** Real routed browser attachment and cleanup after exact display-Worker loss. */
export default async function verify(context: NativeBrowserFixtureContext) {
  const { page, admin, otherAdmin, credentials } = context;
  const primary = String((await admin(["kernel.status"])).instance_uuid);
  const secondary = String((await otherAdmin(["kernel.status"])).instance_uuid);
  for (
    const [node, url] of [[primary, context.baseURL], [
      secondary,
      context.otherNodeURL,
    ]]
  ) {
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = listener.addr.port;
    listener.close();
    const command = [
      "system.nodes.set",
      node!,
      "--url",
      url!,
      "--recipient-address",
      "127.0.0.1",
      "--recipient-port",
      String(port),
      "--enabled",
    ];
    await admin(command);
    await otherAdmin(command);
  }
  // Recipient listeners bind at node startup. Configure them before creating
  // the retained terminal, then restart only these disposable fixture nodes.
  await context.restartNodes();
  await context.waitForScreen(page, "Welcome to 80|20", 60_000);
  await admin(["dev-core.sandbox.create", credentials.username]);
  await admin(["dev-core.sandbox.start", credentials.username]);
  const list = await admin(["dev-core.sandbox.list"]);
  const sandbox = (list.sandboxes as { user_id: string; sandbox_id: string }[])
    .find((value) => value.user_id === credentials.username);
  assert(sandbox);
  const shell = async (command: string) => {
    const result = await admin([
      "dev-core.sandbox.shell",
      credentials.username,
      "--command",
      command,
    ]);
    return (result.shell as { output: string }).output;
  };
  await page.evaluate(
    `globalThis.terminalBenchmark=(${browserDriver.toString()})()`,
  );
  const id = await page.evaluate<string>(
    `terminalBenchmark.open('retained', ${
      JSON.stringify(sandbox.sandbox_id)
    }, ${
      JSON.stringify(
        "stty -echo; printf '%s' $$ > /tmp/8020-resilience-pid; while IFS= read -r ticket; do printf '\\036DONE:%s\\037' \"$ticket\"; done",
      )
    })`,
  );
  const terminal = await page.evaluate<
    { id: string; terminalId: string; route: string }
  >(
    `terminalBenchmark.terminal(${JSON.stringify(id)})`,
  );
  await page.evaluate(
    `terminalBenchmark.run(${JSON.stringify(id)}, 'primary')`,
  );
  const pid = await shell("cat /tmp/8020-resilience-pid");
  assert(/^\d+$/.test(pid));
  const placement = await admin([
    "db.sql",
    `SELECT "nodeId", "workerId" FROM "the8020__dev_core__terminals" WHERE "terminalId" = '${terminal.terminalId}'`,
  ]);
  const row = (placement.rows as string[][])[0];
  assert(
    row && row[0] === primary,
    "initial physical/display owner on primary node",
  );
  await page.evaluate(`terminalBenchmark.detach(${JSON.stringify(id)})`);
  const other = await context.openPage();
  await other.command("Page.navigate", {
    url: `${context.otherNodeURL}/the8020/uui/shell/`,
  });
  await context.waitForPage(
    other,
    `location.origin===${
      JSON.stringify(context.otherNodeURL)
    } && document.readyState==='complete'`,
    "second-node navigation committed",
    60_000,
  );
  await context.waitForScreen(other, "Welcome to 80|20", 60_000);
  const initialStatus = await other.evaluate<number>(
    `fetch('/the8020/dev-core/terminals/status', {headers:{'the8020-route':${
      JSON.stringify(terminal.route)
    }}}).then(response=>response.status)`,
  );
  assertEquals(
    initialStatus,
    200,
    "cross-node HTTP reaches the exact live owner",
  );
  await other.evaluate(
    `globalThis.terminalBenchmark=(${browserDriver.toString()})()`,
  );
  const adopted = await other.evaluate<string>(
    `terminalBenchmark.adopt(${JSON.stringify(terminal)})`,
  );
  await other.evaluate(
    `terminalBenchmark.run(${JSON.stringify(adopted)}, 'secondary')`,
  );
  assertEquals(
    await shell(`kill -0 ${pid}; cat /tmp/8020-resilience-pid`),
    pid,
  );
  console.log(
    `Cross-node native attachment passed: ${terminal.id}, Bash PID ${pid}`,
  );
  await admin(["worker", "kill", row[1]!]);
  const status = await other.evaluate<number>(
    `fetch('/the8020/dev-core/terminals/status', {headers:{'the8020-route':${
      JSON.stringify(terminal.route)
    }}}).then(response=>response.status)`,
  );
  assertEquals(status, 409, "lost exact display owner stays unavailable");
  assertEquals(
    await shell(`kill -0 ${pid}; cat /tmp/8020-resilience-pid`),
    pid,
    "Worker loss retains the physical process",
  );
  const reopened = await page.evaluate<string>(
    `terminalBenchmark.open('retained', ${
      JSON.stringify(sandbox.sandbox_id)
    }, 'exit 99', ${JSON.stringify(terminal.id)})`,
  );
  const current = await page.evaluate<
    { id: string; terminalId: string; route: string }
  >(`terminalBenchmark.terminal(${JSON.stringify(reopened)})`);
  assertEquals(current.id, terminal.id);
  assertEquals(
    current.terminalId,
    terminal.terminalId,
    "new display owner adopts the surviving shell",
  );
  assert(
    current.route !== terminal.route,
    "display replacement receives a fresh exact route",
  );
  await page.evaluate(
    `terminalBenchmark.run(${JSON.stringify(reopened)}, 'after-worker-loss')`,
  );
  assertEquals(
    await shell(`kill -0 ${pid}; cat /tmp/8020-resilience-pid`),
    pid,
  );
  const replacement = (await admin([
    "db.sql",
    `SELECT "workerId" FROM "the8020__dev_core__terminals" WHERE "terminalId" = '${terminal.terminalId}'`,
  ])).rows as string[][];
  await admin(["worker", "kill", replacement[0]![0]!]);
  await other.evaluate(`terminalBenchmark.close(${JSON.stringify(adopted)})`);
  assertEquals(
    await shell(
      `if kill -0 ${pid} 2>/dev/null; then printf alive; else printf closed; fi`,
    ),
    "closed",
    "explicit close from a different node cleans the orphan PTY",
  );
  const remaining = await admin([
    "db.sql",
    `SELECT "terminalId" FROM "the8020__dev_core__terminals" WHERE "terminalId" = '${terminal.terminalId}'`,
  ]);
  assertEquals(remaining.rows, [], "explicit cleanup removes metadata");
  console.log(
    `Display-owner loss retained the process; cross-node explicit close cleaned ${terminal.id}`,
  );
}
