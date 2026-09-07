import { context } from "@the8020/context";
import {
  defineService,
  HTTPError,
  type PlatformService,
  type RequestMetadata,
  z,
} from "@the8020/http";
import { kernel, WorkerInvokeError } from "@the8020/kernel";
import type { TerminalMetadataStore, TerminalRecord } from "./metadata.ts";
import { TerminalBusyError, TerminalOwner } from "./owner.ts";
import { TERMINAL_PROTOCOL, type TerminalItem } from "./protocol.ts";

const Target = z.object({
  targetKind: z.enum(["development", "runtime"]),
  targetSandboxId: z.string().regex(/^sbx-[a-z0-9]{10}$/),
});
const Size = z.object({
  columns: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
});
const Create = Target.extend({
  name: z.string().trim().min(1).max(80).optional(),
  arguments: z.array(z.string().max(8192)).min(1).max(64),
  environment: z.array(z.string().max(8192)).max(128).default([]),
  workingDir: z.string().min(1).max(4096),
  size: Size,
}).strict();
const TerminalID = z.string().regex(/^tty-[a-z0-9]{10}$/);

interface Entry {
  record: TerminalRecord;
  owner: TerminalOwner;
  completion: Promise<void>;
}
const owners = new Map<string, Entry>();

interface TerminalServiceDependencies {
  terminals: typeof kernel.terminals;
  runPersistent: typeof kernel.execution.runPersistent;
  completePersistent: typeof kernel.execution.completePersistent;
  route: typeof kernel.services.route;
  invoke: typeof kernel.worker.invoke;
}
const nativeDependencies: TerminalServiceDependencies = {
  terminals: kernel.terminals,
  runPersistent: kernel.execution.runPersistent,
  completePersistent: kernel.execution.completePersistent,
  route: kernel.services.route,
  invoke: kernel.worker.invoke,
};

export function defineTerminalService(
  store: TerminalMetadataStore,
  dependencies: TerminalServiceDependencies = nativeDependencies,
): PlatformService {
  const { terminals, runPersistent, completePersistent, route, invoke } =
    dependencies;
  const item = async (record: TerminalRecord): Promise<TerminalItem> => ({
    id: record.terminalId,
    name: record.name,
    route: await route(target(record)),
  });
  const temporary = async (
    meta: RequestMetadata,
    action: () => Promise<Response>,
  ): Promise<Response> => {
    authenticated(meta);
    if (owners.has(persistentId(meta))) {
      throw new HTTPError(409, {
        error: "This operation requires an independent request",
      });
    }
    return await action();
  };
  const service = defineService();
  service.post(
    "/list",
    { summary: "List development terminals", body: Target.strict() },
    async ({ body: target, meta }) => {
      return await temporary(meta, async () => {
        const records = await store.list(
          meta.user.userId,
          target.targetKind,
          target.targetSandboxId,
        );
        return Response.json({
          terminals: await Promise.all(records.map(item)),
        });
      });
    },
  );
  service.post(
    "/create",
    { summary: "Create a retained terminal", body: Create },
    async ({ body: input, meta }) => {
      authenticated(meta);
      if (owners.has(persistentId(meta))) {
        throw new HTTPError(409, {
          error: "This operation requires an independent request",
        });
      }
      const ready = Promise.withResolvers<TerminalItem>();
      const completed = Promise.withResolvers<void>();
      void runPersistent(async () => {
        const existing = await store.list(
          meta.user.userId,
          input.targetKind,
          input.targetSandboxId,
        );
        if (existing.length >= 256) {
          throw new Error("Close unused terminals before creating another");
        }
        const native = await terminals.create({
          kind: input.targetKind,
          sandboxId: input.targetSandboxId,
          arguments: input.arguments,
          environment: input.environment,
          workingDir: input.workingDir,
          size: input.size,
        });
        const owner = new TerminalOwner(native, terminals);
        const record: TerminalRecord = {
          terminalId: native.terminal.id,
          name: input.name ?? nextName(existing),
          authenticatedUserId: meta.user.userId,
          targetKind: input.targetKind,
          targetSandboxId: input.targetSandboxId,
          nodeId: meta.execution.nodeId,
          ownerSandboxId: meta.execution.sandboxId,
          workerId: meta.execution.workerId,
          persistentExecutionId: persistentId(meta),
          createdAt: new Date(),
        };
        const entry = { record, owner, completion: completed.promise };
        owners.set(record.persistentExecutionId, entry);
        const running = owner.run();
        // Observe early processor failures while the metadata insert is in flight.
        void running.catch(() => {});
        let accepted = false;
        try {
          await store.create(record);
          ready.resolve(await item(record));
          accepted = true;
          await running;
          await store.remove(record.authenticatedUserId, record.terminalId);
        } catch (error) {
          if (!accepted) {
            await owner.close();
            await running.catch(() => {});
            await store.remove(record.authenticatedUserId, record.terminalId);
          }
          throw error;
        } finally {
          owners.delete(record.persistentExecutionId);
        }
      }).catch((error) => {
        ready.reject(error);
        console.error("Terminal display owner stopped", error);
      }).finally(() => completed.resolve());
      return Response.json({ terminal: await ready.promise });
    },
  );
  service.post(
    "/rename",
    {
      summary: "Rename a terminal",
      body: z.object({
        terminalId: TerminalID,
        name: z.string().trim().min(1).max(80),
      }).strict(),
    },
    async ({ body: input, meta }) => {
      return await temporary(meta, async () => {
        await requireRecord(store, meta, input.terminalId);
        await store.rename(meta.user.userId, input.terminalId, input.name);
        return Response.json({ renamed: true });
      });
    },
  );
  service.post(
    "/close",
    {
      summary: "Close a terminal",
      body: z.object({ terminalId: TerminalID }).strict(),
    },
    async ({ body: input, meta }) => {
      return await temporary(meta, async () => {
        const record = await store.get(meta.user.userId, input.terminalId);
        if (!record) return Response.json({ closed: true });
        try {
          await invoke({
            ...target(record),
            function: "terminal.close",
            input: { terminalId: record.terminalId },
          });
        } catch (error) {
          if (
            !(error instanceof WorkerInvokeError) ||
            !["target_not_found", "target_mismatch"].includes(error.code)
          ) throw error;
          // The exact display owner is gone. Physical close is still explicit and idempotent.
          await terminals.close({
            terminalId: record.terminalId,
            nodeId: record.nodeId,
          });
          await store.remove(meta.user.userId, record.terminalId);
        }
        return Response.json({ closed: true });
      });
    },
  );
  service.get(
    "/status",
    { summary: "Check the retained terminal owner" },
    ({ meta }) => {
      const entry = owned(meta);
      return Response.json({
        terminalId: entry.record.terminalId,
        ...entry.owner.state(),
      });
    },
  );
  service.get(
    "/snapshot",
    { summary: "Recover the current terminal display" },
    async ({ request, meta }) => {
      const entry = owned(meta);
      return await entry.owner.snapshot(
        new URL(request.url).searchParams.get("view") ?? "",
        request.signal,
      );
    },
  );
  service.websocket("/connect", async ({ meta, socket }) => {
    const entry = owned(meta);
    if (socket.protocol !== TERMINAL_PROTOCOL) {
      socket.close(1002, "Unsupported terminal protocol");
      return;
    }
    const first = await socket.receive();
    if (
      first.type !== "message" || typeof first.data !== "string" ||
      first.data.length > 4096
    ) {
      socket.close(1002, "Terminal attachment is required");
      return;
    }
    const input = z.object({
      type: z.literal("attach"),
      clientId: z.string().min(1).max(80),
      takeover: z.boolean().default(false),
    }).strict().parse(JSON.parse(first.data));
    let view: Awaited<ReturnType<TerminalOwner["attach"]>>;
    try {
      view = await entry.owner.attach(socket, input.clientId, input.takeover);
    } catch (error) {
      socket.send(
        JSON.stringify({
          type: "error",
          message: message(error),
          busy: error instanceof TerminalBusyError,
        }),
      );
      socket.close(1008, "Terminal control is unavailable");
      return;
    }
    try {
      view.send(JSON.stringify({ type: "snapshot", viewId: view.id }));
      while (!socket.signal.aborted && !view.closed) {
        const incoming = await socket.receive();
        if (incoming.type === "close") break;
        if (incoming.data instanceof Uint8Array) {
          view.input(incoming.data);
          continue;
        }
        if (incoming.data.length > 4096) {
          throw new Error("Terminal control message is too large");
        }
        const command = JSON.parse(incoming.data) as Record<string, unknown>;
        if (command.type === "ready") {
          view.ready(z.number().int().nonnegative().parse(command.sequence));
        } else if (command.type === "ack") {
          view.acknowledge(
            z.number().int().nonnegative().parse(command.sequence),
          );
        } else if (command.type === "resize") {
          await terminals.resize(
            view.attachment.attachmentId,
            Size.parse(command.size),
            view.signal,
          );
          view.send(JSON.stringify({ type: "resize-ack" }));
        } else if (command.type === "ping") {
          view.send(JSON.stringify({ type: "pong" }));
        } else throw new Error("Unknown terminal control message");
      }
    } catch (error) {
      if (!socket.signal.aborted) {
        view.send(JSON.stringify({ type: "error", message: message(error) }));
        view.close(1011, "Terminal attachment failed");
      }
    } finally {
      await entry.owner.detach(view);
    }
  });
  // Every admitted request receives a binding, including invalid paths. The
  // package keeps only bindings with an actual terminal owner.
  const completeUnowned = async (
    meta: RequestMetadata,
    action: () => Promise<Response>,
  ) => {
    try {
      return await action();
    } finally {
      if (!owners.has(persistentId(meta))) await completePersistent();
    }
  };
  return Object.freeze<PlatformService>({
    __the8020Service: true as const,
    fetch: (request, runtime) =>
      completeUnowned(runtime.meta, () => service.fetch(request, runtime)),
    connectWebSocket: (request, runtime, socket) =>
      completeUnowned(runtime.meta, () => {
        if (!runtime.meta.auth.authenticated) {
          return Promise.resolve(
            Response.json({ error: "Authentication is required" }, {
              status: 401,
            }),
          );
        }
        const entry = owners.get(persistentId(runtime.meta));
        if (
          !entry ||
          entry.record.authenticatedUserId !== runtime.meta.user.userId
        ) {
          return Promise.resolve(
            Response.json({ error: "Terminal display owner is unavailable" }, {
              status: 409,
            }),
          );
        }
        return service.connectWebSocket(request, runtime, socket);
      }),
    openapi: (metadata) => service.openapi(metadata),
  });
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
function authenticated(meta: RequestMetadata): void {
  if (!meta.auth.authenticated) {
    throw new HTTPError(401, { error: "Authentication is required" });
  }
}
function persistentId(meta: RequestMetadata): string {
  const id = meta.execution.persistentExecutionId;
  if (!id) throw new Error("Persistent terminal execution is unavailable");
  return id;
}
function owned(meta: RequestMetadata): Entry {
  authenticated(meta);
  const entry = owners.get(persistentId(meta));
  if (!entry || entry.record.authenticatedUserId !== meta.user.userId) {
    throw new HTTPError(409, {
      error: "Terminal display owner is unavailable",
    });
  }
  return entry;
}
async function requireRecord(
  store: TerminalMetadataStore,
  meta: RequestMetadata,
  id: string,
): Promise<TerminalRecord> {
  const record = await store.get(meta.user.userId, id);
  if (!record) throw new Error("Terminal is unavailable");
  return record;
}
function target(record: TerminalRecord) {
  return {
    nodeId: record.nodeId,
    sandboxId: record.ownerSandboxId,
    workerId: record.workerId,
    persistentExecutionId: record.persistentExecutionId,
  };
}
function nextName(records: TerminalRecord[]): string {
  const names = new Set(records.map((record) => record.name));
  let ordinal = 1;
  while (names.has(`Terminal ${ordinal}`)) ordinal++;
  return `Terminal ${ordinal}`;
}

export const workerFunctions = Object.freeze({
  "terminal.close": async (input: unknown): Promise<{ closed: true }> => {
    const terminalId =
      z.object({ terminalId: TerminalID }).strict().parse(input).terminalId;
    const entry = [...owners.values()].find((value) =>
      value.record.terminalId === terminalId
    );
    if (!entry || entry.record.authenticatedUserId !== context.userId) {
      throw new Error("Terminal owner is unavailable");
    }
    await entry.owner.close();
    await entry.completion;
    return { closed: true };
  },
});
