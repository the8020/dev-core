import { assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";

/** Exercise the actual helper -> package command -> kernel -> sandbox path. */
export default async function verify(context: NativeBrowserFixtureContext) {
  const { page, admin, credentials, click, clickRow, waitForPage } = context;
  const ready = (id: string) =>
    waitForPage(
      page,
      `document.querySelector('.sandbox-console')?.dataset.terminalState === 'connected' &&
       document.querySelector('.sandbox-console')?.dataset.terminalId === '${id}' &&
       !document.querySelector('[data-terminal-action=new]')?.disabled`,
      `terminal ${id} connected`,
      60_000,
    );
  await clickRow(page, "the8020/dev-core/development-test");
  await ready("1");
  await click(page, "[data-terminal-action=new]");
  await ready("2");

  const processes = async () => {
    const result = await admin([
      "dev-core.sandbox.shell",
      credentials.username,
      "--command",
      "ps -eo pid,lstart,args | grep '/bin/bash -l$' | sort",
    ]);
    return (result.shell as { output: string }).output;
  };
  const before = await processes();
  for (const iteration of [1, 2]) {
    const result = await admin([
      "dev-core.sandbox.shell",
      credentials.username,
      "--command",
      `printf '${iteration}\\n' > /workspace/packages/the8020/demo/helper-recovery.txt && activate --json --package the8020/demo --message 'Helper recovery ${iteration}'`,
    ]);
    const activation = JSON.parse((result.shell as { output: string }).output);
    assertEquals(activation.success, true);
    assertEquals(await processes(), before);
    await click(page, "[data-terminal-action=refresh]");
    await ready("2");
  }

  await page.command("Network.enable");
  await page.command("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await waitForPage(
    page,
    "document.querySelector('.sandbox-console')?.dataset.terminalState === 'disconnected'",
    "offline terminal detaches",
  );
  await page.command("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await ready("2");
  for (const id of ["3", "4", "5"]) {
    await click(page, "[data-terminal-action=new]");
    await ready(id);
  }
  assertEquals(
    await page.evaluate(
      "Array.from(document.querySelector('.sandbox-console-select').options, option => option.value)",
    ),
    ["1", "2", "3", "4", "5"],
  );
  console.log(
    "Native recovery passed: repeated helper activation, process continuity, terminal reconnect, offline recovery, and New IDs 3/4/5.",
  );
}
