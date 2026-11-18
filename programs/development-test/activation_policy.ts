import { assert, assertEquals, assertRejects } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";

export default async function verify(context: NativeBrowserFixtureContext) {
  const {
    admin,
    credentials,
    page,
    root,
    clickButton,
    clickRow,
    waitForScreen,
  } = context;
  const user = credentials.username;
  const profile = (role: string) =>
    admin([
      "runtime",
      "eval",
      `import { setSystemProfile } from "/p/the8020/system/profile.ts";
       export default () => setSystemProfile({name: "Activation policy", role: ${
        JSON.stringify(role)
      }});`,
      "--read",
      "/workspace/packages",
    ]);
  const override = (value: string) =>
    admin(["kernel.config.set", "development.activation_allowed", value]);
  const shell = async (command: string) => {
    const result = await admin([
      "dev-core.sandbox.shell",
      user,
      "--command",
      command,
    ]);
    return (result.shell as { output: string }).output;
  };
  await admin(["auth.users.assign", user, "the8020.users.administrator"]);
  await clickButton(page, "Refresh");
  await waitForScreen(page, "Welcome to 80|20");
  await profile("test");
  await clickRow(page, "the8020/dev-core/development-test");
  await waitForScreen(page, "Development", 60_000);
  assertEquals(await shell("printf ready"), "ready");
  await admin(["dev-core.sandbox.stop", user]);
  await profile("production");
  await admin(["dev-core.sandbox.start", user]);
  assertEquals(await shell("printf ready"), "ready");
  await shell(
    "sleep 900 </dev/null >/dev/null 2>&1 & echo $! >/tmp/policy-pid",
  );
  const identity = () =>
    shell(
      'set -e; read -r process_pid </tmp/policy-pid; read -ra process_stat <"/proc/$process_pid/stat"; echo "${process_stat[0]} ${process_stat[21]}"',
    );
  const before = await identity();
  const relative = "the8020/activation-policy-fixture";
  await shell(
    `mkdir -p /workspace/packages/${relative}; printf 'schema = 1\n' >/workspace/packages/${relative}/package.toml; printf 'initial' >/workspace/packages/${relative}/value.txt`,
  );
  let published = "";
  for (const role of ["development", "test", "production"]) {
    await profile(role);
    for (const value of ["auto", "true", "false"]) {
      await override(value);
      const expected = `${role}-${value}`;
      await shell(
        `printf '${expected}' >/workspace/packages/${relative}/value.txt`,
      );
      const output = await shell(
        `activate --json --package ${relative} --message 'Activation policy ${expected}' 2>&1; printf '\nEXIT=%s\n' "$?"`,
      );
      const allowed = value === "true" ||
        (value === "auto" && role === "development");
      assertEquals(output.endsWith("EXIT=0\n"), allowed, output);
      if (allowed) published = expected;
      else {
        assert(output.includes("development.activation_allowed"), output);
        await assertRejects(
          () =>
            admin([
              "dev-core.activate.run",
              user,
              "--message",
              "Blocked command",
            ]),
          Error,
          "Sandbox activation",
        );
        await admin(["dev-core.activate.preview", user]);
        await admin(["dev-core.activate.run", user, "--action", "status"]);
        await admin(["dev-core.activate.run", user, "--action", "abort"]);
      }
      assertEquals(
        await Deno.readTextFile(`${root}/packages/${relative}/value.txt`),
        published,
      );
      assertEquals(await identity(), before);
      assertEquals(
        await shell(`cat /workspace/packages/${relative}/value.txt`),
        expected,
      );
    }
  }
  await admin(["kernel.config.unset", "development.activation_allowed"]);
  const setting = await admin([
    "kernel.config.get",
    "development.activation_allowed",
  ]);
  assertEquals(
    (setting.setting as { active_value: string }).active_value,
    "auto",
  );
  await profile("development");
  console.log(
    "Sandbox role/override matrix, terminal continuity and publication checks passed",
  );
}
