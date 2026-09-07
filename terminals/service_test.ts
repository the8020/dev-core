import { assert, assertEquals } from "@std/assert";
import type { RequestMetadata } from "@the8020/http";
import { WorkerInvokeError } from "@the8020/kernel";
import { installContextProvider } from "../../kernel/defaults/config/runtime/deno/context/runtime.ts";
import type { TerminalMetadataStore, TerminalRecord } from "./metadata.ts";
import { defineTerminalService, workerFunctions } from "./service.ts";
import { snapshotJSON, TestSocket, TestTerminals } from "./test_support.ts";

const target = {
  targetKind: "development",
  targetSandboxId: "sbx-0000000001",
} as const;
const create = {
  ...target,
  arguments: ["/bin/bash", "-l"],
  environment: ["TERM=xterm-256color"],
  workingDir: "/workspace",
  size: { columns: 80, rows: 24 },
};

function metadata(id = "pex-0000000001", userId = "user:one"): RequestMetadata {
  return {
    contextId: "ctx-0000000001",
    serviceId: "the8020/dev-core/terminals",
    serviceGeneration: 1,
    canonicalBasePath: "/the8020/dev-core/terminals",
    originalUrl: "https://example.test/the8020/dev-core/terminals/create",
    client: { ipAddress: "127.0.0.1", networkScope: "loopback" },
    persistentExecutionId: id,
    persistentKeepAliveMilliseconds: 0,
    execution: {
      nodeId: "nod-0000000001",
      sandboxId: "sbx-0000000002",
      workerId: "wrk-0000000001",
      persistentExecutionId: id,
    },
    user: { userId, username: "one" },
    auth: { authenticated: true, realm: "user", userId, username: "one" },
  };
}

class MemoryMetadata implements TerminalMetadataStore {
  readonly records = new Map<string, TerminalRecord>();
  beforeCreate?: () => Promise<void>;
  list(
    user: string,
    kind: TerminalRecord["targetKind"],
    sandbox: string,
  ): Promise<TerminalRecord[]> {
    return Promise.resolve(
      [...this.records.values()].filter((record) =>
        record.authenticatedUserId === user && record.targetKind === kind &&
        record.targetSandboxId === sandbox
      ),
    );
  }
  get(user: string, id: string): Promise<TerminalRecord | undefined> {
    const record = this.records.get(id);
    return Promise.resolve(
      record?.authenticatedUserId === user ? record : undefined,
    );
  }
  async create(record: TerminalRecord): Promise<void> {
    await this.beforeCreate?.();
    this.records.set(record.terminalId, record);
  }
  async rename(user: string, id: string, name: string): Promise<void> {
    const record = await this.get(user, id);
    if (record) record.name = name;
  }
  async remove(user: string, id: string): Promise<void> {
    if (await this.get(user, id)) this.records.delete(id);
  }
}

function fixture() {
  const native = new TestTerminals();
  const store = new MemoryMetadata();
  const lifetimes: Promise<void>[] = [];
  let completions = 0;
  let failRoute = false;
  const service = defineTerminalService(store, {
    terminals: native.api,
    runPersistent: (handler) => {
      const lifetime = handler().finally(() => completions++);
      lifetimes.push(lifetime);
      return lifetime;
    },
    completePersistent: () => {
      completions++;
      return Promise.resolve();
    },
    route: () =>
      failRoute
        ? Promise.reject(new Error("Route signing failed"))
        : Promise.resolve("signed-terminal-route"),
    invoke: async <Result>(
      input: { function: string; input: unknown },
    ): Promise<Result> => {
      if (input.function !== "terminal.close") {
        throw new Error("Unexpected invocation");
      }
      return await workerFunctions["terminal.close"](input.input) as Result;
    },
  });
  const current = metadata();
  const release = installContextProvider(() => ({
    type: "service",
    id: current.execution.persistentExecutionId!,
    contextId: current.contextId,
    nodeId: current.execution.nodeId,
    sandboxId: current.execution.sandboxId,
    workerId: current.execution.workerId,
    userId: current.user.userId,
    username: current.user.username,
    authenticated: current.auth.authenticated,
  }));
  const fetch = (
    path: string,
    value?: unknown,
    meta = metadata("pex-0000000002"),
    controller = new AbortController(),
  ) =>
    service.fetch(
      new Request(`https://service${path}`, {
        method: value === undefined ? "GET" : "POST",
        ...(value === undefined ? {} : {
          body: JSON.stringify(value),
          headers: { "content-type": "application/json" },
        }),
        signal: controller.signal,
      }),
      { signal: controller.signal, meta },
    );
  return {
    native,
    store,
    service,
    fetch,
    finished: () => Promise.all(lifetimes),
    get completions() {
      return completions;
    },
    failRoute() {
      failRoute = true;
    },
    async dispose() {
      try {
        for (const record of store.records.values()) {
          await workerFunctions["terminal.close"]({
            terminalId: record.terminalId,
          });
        }
        await Promise.allSettled(lifetimes);
      } finally {
        release();
      }
    },
  };
}

Deno.test("kernel expiry removes terminal metadata and completes its retained handler", async () => {
  const test = fixture();
  try {
    const created = await test.fetch("/create", create, metadata());
    assertEquals(created.status, 200);
    const { terminal } = await created.json();
    test.native.expire();
    await test.finished();
    assertEquals(test.store.records.size, 0);
    assertEquals(test.completions, 1);
    assertEquals(test.native.closed, [terminal.id]);
    assertEquals(test.native.detached, [test.native.native.attachmentId]);
  } finally {
    await test.dispose();
  }
});

Deno.test("terminal establishment survives request loss and list, rename, detach, and close retain exact ownership", async () => {
  const test = fixture();
  try {
    const inserted = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    test.store.beforeCreate = () => {
      started.resolve();
      return inserted.promise;
    };
    const request = new AbortController();
    const creating = test.fetch("/create", create, metadata(), request);
    await started.promise;
    request.abort();
    inserted.resolve();
    const created = await creating;
    assertEquals(created.status, 200);
    const { terminal } = await created.json();
    assertEquals(terminal.name, "Terminal 1");
    assertEquals(test.completions, 0);
    assertEquals(test.native.created, 1);
    assertEquals(
      test.store.records.get(terminal.id)?.ownerSandboxId,
      "sbx-0000000002",
    );
    assertEquals(
      test.store.records.get(terminal.id)?.targetSandboxId,
      target.targetSandboxId,
    );
    assertEquals(
      JSON.stringify([...test.store.records.values()]).includes(
        "signed-terminal-route",
      ),
      false,
    );

    const list = await test.fetch("/list", target);
    assertEquals((await list.json()).terminals, [terminal]);
    assertEquals(test.completions, 1);
    const other = await test.fetch(
      "/list",
      target,
      metadata("pex-0000000003", "user:other"),
    );
    assertEquals((await other.json()).terminals, []);
    const rename = await test.fetch("/rename", {
      terminalId: terminal.id,
      name: "Agent",
    });
    assertEquals(rename.status, 200);
    assertEquals(test.store.records.get(terminal.id)?.name, "Agent");

    const socket = new TestSocket();
    const accepted = await test.service.connectWebSocket(
      new Request("https://service/connect"),
      { meta: metadata(), signal: socket.signal },
      socket,
    );
    assertEquals(accepted.status, 204);
    socket.message({ type: "attach", clientId: "browser" });
    const snapshot = await socket.messageOfType("snapshot");
    const response = await test.fetch(
      `/snapshot?view=${snapshot.viewId}`,
      undefined,
      metadata(),
    );
    assertEquals(response.status, 200);
    await snapshotJSON(response);
    socket.message({
      type: "ready",
      sequence: Number(response.headers.get("x-terminal-sequence")),
    });
    await socket.messageOfType("ready");
    socket.close();
    await test.native.output("after logout\u001b[6n");
    assertEquals(test.native.replies.length, 1);
    assertEquals(test.native.closed, []);

    const closed = await test.fetch("/close", { terminalId: terminal.id });
    assertEquals(closed.status, 200);
    assertEquals(test.native.closed, [terminal.id]);
    assertEquals(test.store.records.size, 0);
    const stale = await test.service.connectWebSocket(
      new Request("https://service/connect"),
      { meta: metadata(), signal: new AbortController().signal },
      new TestSocket(),
    );
    assertEquals(stale.status, 409);
    assertEquals(test.native.created, 1);
  } finally {
    await test.dispose();
  }
});

Deno.test("failed initial publication closes its PTY and removes metadata", async () => {
  const test = fixture();
  try {
    test.failRoute();
    const response = await test.fetch("/create", create, metadata());
    assertEquals(response.status, 500);
    assertEquals(test.native.created, 1);
    assertEquals(test.native.closed, [test.native.native.terminal.id]);
    assertEquals(test.store.records.size, 0);
  } finally {
    await test.dispose();
  }
});

Deno.test("invalid and unowned terminal requests release temporary bindings", async () => {
  const test = fixture();
  try {
    assertEquals((await test.fetch("/unknown")).status, 404);
    assertEquals(test.completions, 1);
    assertEquals((await test.fetch("/create", {})).status, 400);
    assertEquals(test.completions, 2);
    const meta = metadata();
    meta.auth.authenticated = false;
    assertEquals((await test.fetch("/list", target, meta)).status, 401);
    assertEquals(test.completions, 3);
    assertEquals(test.native.created, 0);
  } finally {
    await test.dispose();
  }
});

Deno.test("explicit close reaches the terminal node after its display Worker has disappeared", async () => {
  const store = new MemoryMetadata();
  const native = new TestTerminals();
  const meta = metadata();
  const record: TerminalRecord = {
    terminalId: native.native.terminal.id,
    name: "Gone owner",
    authenticatedUserId: meta.user.userId,
    ...target,
    nodeId: "nod-bbbbbbbbbb",
    ownerSandboxId: meta.execution.sandboxId,
    workerId: meta.execution.workerId,
    persistentExecutionId: meta.execution.persistentExecutionId!,
    createdAt: new Date(),
  };
  await store.create(record);
  let selected: unknown;
  const service = defineTerminalService(store, {
    terminals: {
      ...native.api,
      close: (target) => {
        selected = target;
        return native.api.close(target);
      },
    },
    runPersistent: () => Promise.reject(new Error("Unexpected creation")),
    completePersistent: () => Promise.resolve(),
    route: () => Promise.resolve("route"),
    invoke: () =>
      Promise.reject(
        new WorkerInvokeError({
          code: "target_mismatch",
          message: "Missing binding",
        }),
      ),
  });
  const response = await service.fetch(
    new Request("https://service/close", {
      method: "POST",
      body: JSON.stringify({ terminalId: record.terminalId }),
    }),
    { meta, signal: new AbortController().signal },
  );
  assertEquals(response.status, 200);
  assertEquals(native.closed, [record.terminalId]);
  assertEquals(selected, {
    terminalId: record.terminalId,
    nodeId: record.nodeId,
  });
  assertEquals(store.records.size, 0);
  assertEquals(native.created, 0);
  assert(!JSON.stringify(record).includes("route"));
});
