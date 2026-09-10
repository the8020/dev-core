import { assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";

// Use the ordinary installer binaries, including after moving their directory.
export default async function verify(context: NativeBrowserFixtureContext) {
  const { admin, root, credentials } = context;
  const user = credentials.username;
  await admin(["dev-core.sandbox.create", user]);
  await admin(["dev-core.sandbox.start", user]);
  const shell = async (command: string) => {
    const result = await admin([
      "dev-core.sandbox.shell",
      user,
      "--command",
      command,
    ]);
    return (result.shell as { output: string }).output;
  };
  const identity = () =>
    shell(
      'read -r process_pid </tmp/activation-worker.pid; read -ra process_stat <"/proc/$process_pid/stat"; printf \'%s %s\\n\' "${process_stat[0]}" "${process_stat[21]}"',
    );
  await shell(
    "sleep 300 </dev/null >/dev/null 2>&1 & echo $! >/tmp/activation-worker.pid",
  );
  const before = await identity();
  const relative = "the8020/dev-core/fixtures/activation-a/new.txt";
  await shell(`printf 'CLI change\n' >/workspace/packages/${relative}`);
  const cli = JSON.parse(
    await shell(
      "activate --json --package the8020/dev-core --message 'CLI process continuity'",
    ),
  );
  assertEquals(cli.success, true);
  assertEquals(cli.overlay_reset, false);
  assertEquals(await identity(), before);
  assertEquals(
    await Deno.readTextFile(`${root}/packages/${relative}`),
    "CLI change\n",
  );

  await shell(`printf 'UUI change\n' >/workspace/packages/${relative}`);
  // UUI uses this same ordinary activation command without the helper's
  // defer-overlay-reset option. Both paths must preserve the process.
  const ui = await admin([
    "dev-core.activate.run",
    user,
    "--message",
    "UUI process continuity",
  ]);
  assertEquals((ui.activation as { success: boolean }).success, true);
  assertEquals(await identity(), before);
  assertEquals(
    await Deno.readTextFile(`${root}/packages/${relative}`),
    "UUI change\n",
  );

  await admin(["dev-core.sandbox.stop", user]);
  const legacyRoot = `${root}/users/${user}/dev-sandbox/runtime/overlay`;
  const legacyState =
    'schema = 1\n[packages."the8020/dev-core"]\nbase_commit = "retained"\npatch = "patches/private.patch"\n';
  await Deno.mkdir(legacyRoot, { recursive: true });
  await Deno.writeTextFile(`${legacyRoot}/state.toml`, legacyState);
  let refusedLegacyEdits = false;
  try {
    await admin(["dev-core.sandbox.start", user]);
  } catch (error) {
    refusedLegacyEdits = String(error).includes("legacy private edits");
  }
  assertEquals(refusedLegacyEdits, true);
  assertEquals(
    await Deno.readTextFile(`${legacyRoot}/state.toml`),
    legacyState,
  );
  await Deno.remove(`${legacyRoot}/state.toml`);
  await admin(["dev-core.sandbox.start", user]);
  assertEquals(
    await shell(`cat /workspace/packages/${relative}`),
    "UUI change\n",
  );
  console.log(
    "Installed activation passed: CLI/UUI process continuity and legacy private-work protection.",
  );
}
