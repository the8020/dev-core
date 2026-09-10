import { assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";

// Run through the existing native harness with run.py activation's binaries.
export default async function verify(context: NativeBrowserFixtureContext) {
  const {
    page,
    admin,
    credentials,
    root,
    clickButton,
    clickRow,
    setValue,
    waitForScreen,
    waitForPage,
  } = context;
  const user = credentials.username;
  const peer = "activationpeer";
  await admin(["dev-core.sandbox.create", user]);
  await admin(["dev-core.sandbox.start", user]);
  await admin(["dev-core.sandbox.create", peer]);
  await admin(["dev-core.sandbox.start", peer]);
  const shell = async (command: string, developer = user) => {
    const result = await admin([
      "dev-core.sandbox.shell",
      developer,
      "--command",
      command,
    ]);
    return (result.shell as { output: string }).output;
  };
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const packageID = "the8020/activation-fixture";
  const source = `${root}/packages/${packageID}`;
  await shell(
    `mkdir -p /workspace/packages/${packageID}; printf 'schema = 1\n' >/workspace/packages/${packageID}/package.toml; printf 'original\n' >/workspace/packages/${packageID}/label.ts; printf 'original deletion\n' >/workspace/packages/${packageID}/removed.ts; printf 'original untouched\n' >/workspace/packages/${packageID}/untouched.ts`,
  );
  const created = JSON.parse(
    await shell("activate --json --message 'Create activation package'; true"),
  );
  assertEquals(created.success, true, JSON.stringify(created));
  assertEquals(
    await shell(`cat /workspace/packages/${packageID}/label.ts`, peer),
    "original\n",
  );
  await shell(
    `printf 'private\n' >/workspace/packages/${packageID}/label.ts; rm /workspace/packages/${packageID}/removed.ts; printf alive >/tmp/activation-process`,
  );
  await shell(
    `printf 'shared\n' >/workspace/packages/${packageID}/label.ts; printf 'changed upstream\n' >/workspace/packages/${packageID}/removed.ts; printf 'shared untouched\n' >/workspace/packages/${packageID}/untouched.ts; printf alive >/tmp/activation-peer-process`,
    peer,
  );
  const sharedHead = await shell(
    `git -C /workspace/git/shared/${packageID} rev-parse HEAD`,
    peer,
  );
  const privateCommit = (await shell(
    `cd /workspace/packages/${packageID} && git add label.ts removed.ts untouched.ts && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm 'Private peer checkpoint' && git rev-parse HEAD`,
    peer,
  )).trim();
  assertEquals(
    await shell(
      `git -C /workspace/git/shared/${packageID} rev-parse HEAD`,
      peer,
    ),
    sharedHead,
  );
  const published = JSON.parse(
    await shell(
      "activate --json --message 'Other developer changes'; true",
      peer,
    ),
  );
  assertEquals(published.success, true, JSON.stringify(published));
  assertEquals(
    await shell(
      `cat /workspace/packages/${packageID}/label.ts /workspace/packages/${packageID}/untouched.ts`,
    ),
    "private\nshared untouched\n",
  );
  await clickRow(page, "the8020/dev-core/development-test");
  await waitForScreen(page, "Development", 60_000);
  await clickButton(page, "Review changes");
  await waitForScreen(page, "Activate development changes");
  await setValue(page, '[data-bind="message"]', "Resolve activation conflicts");
  await clickButton(page, "Activate all changes");
  try {
    await waitForScreen(page, "Resolve activation conflicts", 30_000);
  } catch (error) {
    const state = await page.evaluate(`({
      status: [...document.querySelectorAll('[data-bind="status"]')].map(e => e.value),
      text: document.querySelector('.presentation-page-layer:not([hidden])')?.innerText,
      exceptions: ${JSON.stringify(page.exceptions)}
    })`);
    const sandbox = await admin(["dev-core.sandbox.inspect", user]);
    throw new Error(
      `${error}; page: ${JSON.stringify(state)}; sandbox: ${
        JSON.stringify(sandbox)
      }`,
    );
  }
  await waitForPage(
    page,
    `document.querySelector('.uui-code-line-added') !== null`,
    "conflict annotations",
  );
  const screenshot = await page.command<{ data: string }>(
    "Page.captureScreenshot",
    { format: "png" },
  );
  await Deno.writeFile(
    new URL(
      "../../../kernel/.development/conflicts.png",
      import.meta.url,
    ),
    Uint8Array.from(atob(screenshot.data), (value) => value.charCodeAt(0)),
  );
  const inspected = await admin(["dev-core.sandbox.inspect", user]);
  const attempt = (inspected.sandbox as {
    last_activation_result: { packages: { conflict_worktree: string }[] };
  }).last_activation_result;
  const worktree = attempt.packages[0]!.conflict_worktree;
  const conflictOutput = await shell(
    "activate --message 'Resolve activation conflicts' 2>&1; activation_code=$?; printf '\\nEXIT:%s\\n' \"$activation_code\"",
  );
  for (
    const expected of [
      "CONFLICT label.ts",
      "CONFLICT removed.ts",
      "git status",
      "Then rerun: activate",
      "EXIT:3",
    ]
  ) {
    assertEquals(conflictOutput.includes(expected), true, conflictOutput);
  }
  assertEquals(
    await shell(`git -C ${quote(worktree)} show :2:label.ts`),
    "private\n",
  );
  await page.evaluate(
    `document.querySelector('.presentation-page-layer:not([hidden]) .uui-code-editor .cm-content[contenteditable="true"]').focus()`,
  );
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await page.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await page.command("Input.insertText", { text: "resolved in UUI\n" });
  await clickButton(page, "Save resolution");
  await waitForPage(
    page,
    `document.querySelector('.presentation-page-layer:not([hidden]) .screen-description')?.textContent.includes('removed.ts')`,
    "deletion conflict selected",
  );
  await shell(
    `printf 'shared while resolving\n' >/workspace/packages/${packageID}/untouched.ts`,
    peer,
  );
  assertEquals(
    JSON.parse(
      await shell(
        "activate --json --message 'Shared update during resolution'",
        peer,
      ),
    ).success,
    true,
  );
  // The terminal takes over the UUI-created attempt, then the UUI continues it.
  await shell(`git -C ${quote(worktree)} rm removed.ts`);
  await clickButton(page, "Refresh from Git");
  await waitForPage(
    page,
    `[...document.querySelectorAll('button')].some(e => e.textContent.trim() === 'Continue activation' && !e.disabled && !e.closest('[inert],[hidden]'))`,
    "all Git conflicts resolved",
  );
  await clickButton(page, "Continue activation");
  await waitForScreen(page, "Activate development changes");
  assertEquals(
    await Deno.readTextFile(`${source}/label.ts`),
    "resolved in UUI\n",
  );
  let removed = false;
  try {
    await Deno.stat(`${source}/removed.ts`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) removed = true;
    else throw error;
  }
  assertEquals(removed, true);
  assertEquals(await shell("cat /tmp/activation-process"), "alive");
  assertEquals(
    await shell(
      `cat /workspace/packages/${packageID}/label.ts /workspace/packages/${packageID}/untouched.ts`,
      peer,
    ),
    "resolved in UUI\nshared while resolving\n",
  );
  await shell(`rm -r /workspace/packages/${packageID}`);
  assertEquals(
    JSON.parse(
      await shell("activate --json --message 'Delete activation package'"),
    ).success,
    true,
  );
  let deleted = false;
  try {
    await Deno.stat(source);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) deleted = true;
    else throw error;
  }
  assertEquals(deleted, true);
  assertEquals(
    await shell(
      `test ! -e /workspace/packages/${packageID}/package.toml && test ! -e /workspace/packages/${packageID}/label.ts && cat /tmp/activation-peer-process`,
      peer,
    ),
    "alive",
  );
  assertEquals(
    await shell(
      `git -C /workspace/packages/${packageID} show ${
        quote(privateCommit)
      }:label.ts`,
      peer,
    ),
    "shared\n",
  );
  await admin(["dev-core.sandbox.stop", peer]);
  await admin(["dev-core.sandbox.start", peer]);
  assertEquals(
    await shell(
      `git -C /workspace/packages/${packageID} show ${
        quote(privateCommit)
      }:label.ts`,
      peer,
    ),
    "shared\n",
  );
  console.log(
    "Native activation passed: two-developer publication and live untouched files, UUI merge, terminal handoff, deletion, and unchanged development runtimes.",
  );
}
