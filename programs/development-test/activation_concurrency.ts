import { assert, assertEquals } from "@std/assert";
import type { NativeBrowserFixtureContext } from "/p/the8020/uui/browser_e2e.ts";

// Separate from the UI scenario: run against the built activation in disposable nodes.
export default async function verify(context: NativeBrowserFixtureContext) {
  const { admin, credentials, root, baseURL } = context;
  const user = credentials.username;
  const peer = "concurrencypeer";
  const packageA = "the8020/concurrent-a";
  const packageB = "the8020/concurrent-b";
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const shell = async (developer: string, command: string) => {
    const result = await admin([
      "dev-core.sandbox.shell",
      developer,
      "--command",
      command,
    ]);
    return (result.shell as { output: string }).output;
  };
  const activate = async (developer: string, ...packages: string[]) =>
    JSON.parse(
      await shell(
        developer,
        `activate --json --message 'Concurrent activation check' ${
          packages.map((id) => `--package ${quote(id)}`).join(" ")
        }; true`,
      ),
    );
  for (const developer of [user, peer]) {
    await admin(["dev-core.sandbox.create", developer]);
    await admin(["dev-core.sandbox.start", developer]);
  }
  for (const id of [packageA, packageB]) {
    await shell(
      user,
      `mkdir -p /workspace/packages/${id} && printf 'schema = 1\\n' >/workspace/packages/${id}/package.toml && printf 'original\\n' >/workspace/packages/${id}/label.txt`,
    );
  }
  const created = await activate(user, packageA, packageB);
  assertEquals(created.success, true, JSON.stringify(created));
  await shell(
    peer,
    `printf 'peer overlap\\n' >/workspace/packages/${packageA}/label.txt; printf 'peer independent\\n' >/workspace/packages/${packageB}/label.txt`,
  );

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hookCalls = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async () => {
      hookCalls++;
      entered.resolve();
      await release.promise;
      return new Response("continue");
    },
  );
  let first: ReturnType<typeof activate> | undefined;
  try {
    const files = {
      "label.txt": "first developer\n",
      "programs/gate/program.toml":
        'schema = 1\ndescription = "Native activation gate"\nentrypoint = "main.ts"\ndiscoverable = false\n',
      "programs/gate/main.ts":
        `export default async function () { const response = await fetch("http://127.0.0.1:${server.addr.port}/", { signal: AbortSignal.timeout(60000) }); if (!response.ok) throw new Error("activation gate failed"); await response.text(); }\n`,
      "hooks/gate.toml":
        `hook = "pre-activate"\ndescription = "Pause native activation"\nprogram = "${packageA}/gate"\n`,
    };
    await shell(
      user,
      `mkdir -p /workspace/packages/${packageA}/programs/gate /workspace/packages/${packageA}/hooks && ` +
        Object.entries(files).map(([path, contents]) =>
          `printf %s ${quote(contents)} >${
            quote(`/workspace/packages/${packageA}/${path}`)
          }`
        ).join(" && "),
    );
    first = activate(user, packageA);
    await bounded(
      Promise.race([
        entered.promise,
        first.then((result) => {
          throw new Error(
            `Activation returned before entering its hook: ${
              JSON.stringify(result)
            }`,
          );
        }),
      ]),
      "first activation did not reach its native hook",
    );

    const independentStarted = performance.now();
    const independent = await bounded(
      activate(peer, packageB),
      "unrelated activation waited for the held hook",
    );
    const independentMilliseconds = performance.now() - independentStarted;
    assertEquals(independent.success, true, JSON.stringify(independent));
    assertEquals(
      await Deno.readTextFile(`${root}/packages/${packageB}/label.txt`),
      "peer independent\n",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/packages/${packageA}/label.txt`),
      "original\n",
    );
    assertEquals((await fetch(`${baseURL}/health`)).status, 200);

    const overlapStarted = performance.now();
    const overlap = await bounded(
      activate(peer, packageA),
      "overlapping activation did not report busy",
    );
    const overlapMilliseconds = performance.now() - overlapStarted;
    assertEquals(overlap.success, false, JSON.stringify(overlap));
    assert(
      String(overlap.error).includes(`package ${packageA} publication is busy`),
      JSON.stringify(overlap),
    );
    assertEquals(hookCalls, 1);
    release.resolve();
    const published = await bounded(
      first,
      "held activation did not finish after release",
    );
    assertEquals(published.success, true, JSON.stringify(published));

    const retry = await activate(peer, packageA);
    assertEquals(retry.status, "conflicted", JSON.stringify(retry));
    const worktree = retry.packages[0].conflict_worktree as string;
    assertEquals(
      await shell(peer, `git -C ${quote(worktree)} show :2:label.txt`),
      "peer overlap\n",
    );
    assertEquals(
      await shell(peer, `git -C ${quote(worktree)} show :3:label.txt`),
      "first developer\n",
    );
    await shell(
      peer,
      `cd ${
        quote(worktree)
      } && printf 'resolved overlap\\n' >label.txt && git add label.txt && git -c user.name=Fixture -c user.email=fixture@example.test commit -qm 'Resolve concurrent activation'`,
    );
    const resumed = await activate(peer, packageA);
    assertEquals(resumed.success, true, JSON.stringify(resumed));
    assertEquals(
      await Deno.readTextFile(`${root}/packages/${packageA}/label.txt`),
      "resolved overlap\n",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/packages/${packageB}/label.txt`),
      "peer independent\n",
    );
    const result = {
      passed: true,
      observed_at: new Date().toISOString(),
      scope:
        "Two developers on one native activation node with SQLite; real helper, evaluator, pre-activation hook and Git conflict retry.",
      independent_activation_while_hook_held_ms: independentMilliseconds,
      overlapping_activation_busy_response_ms: overlapMilliseconds,
      busy_retry_produces_native_git_conflict: true,
      native_resolution_and_reactivation_passed: true,
      health_available_while_hook_held: true,
      hook_calls: hookCalls,
      timing_boundary:
        "Single warm observations, including helper and native runtime transport; not a throughput or asset-cost benchmark.",
      multi_node_and_postgresql_qualified: false,
    };
    await Deno.writeTextFile(
      new URL(
        "../../../kernel/.development/activation-concurrency-results.json",
        import.meta.url,
      ),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(
      "Native activation concurrency passed:",
      JSON.stringify(result),
    );
  } finally {
    release.resolve();
    await first?.catch(() => {});
    await server.shutdown();
  }
}

async function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
