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
import {
  SESSION_ID,
  TERMINAL_PROTOCOL,
  type TerminalItem,
} from "./protocol.ts";

const Target = z.object({
  targetKind: z.enum(["development", "runtime"]),
  targetSandboxId: z.string().regex(/^sbx-[a-z0-9]{10}$/),
});
const Size = z.object({
  columns: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200),
});
const Open = Target.extend({
  sessionId: z.string().regex(SESSION_ID),
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
const opening = new Map<string, Promise<Entry>>();

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
    id: record.sessionId,
    terminalId: record.terminalId,
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
    "/open",
    { summary: "Connect or create a named terminal", body: Open },
    async ({ body: input, meta }) => {
      authenticated(meta);
      if (owners.has(persistentId(meta))) {
        throw new HTTPError(409, {
          error: "This operation requires an independent request",
        });
      }
      const previous = await store.find(
        meta.user.userId,
        input.targetKind,
        input.targetSandboxId,
        input.sessionId,
      );
      if (previous && previous.nodeId !== meta.execution.nodeId) {
        try {
          const current = await invoke<{ exited: boolean } | null>({
            ...target(previous),
            function: "terminal.status",
            input: {
              terminalId: previous.terminalId,
              persistentExecutionId: previous.persistentExecutionId,
            },
          });
          if (current && !current.exited) {
            return Response.json({ terminal: await item(previous) });
          }
        } catch (error) {
          if (
            !(error instanceof WorkerInvokeError) ||
            !["target_not_found", "target_mismatch"].includes(error.code)
          ) throw error;
        }
        throw new HTTPError(409, {
          error: "Open this session on its sandbox's node",
        });
      }
      const ready = Promise.withResolvers<TerminalItem>();
      const prepared = Promise.withResolvers<Entry>();
      void prepared.promise.catch(() => {});
      const completed = Promise.withResolvers<void>();
      const executionId = persistentId(meta);
      opening.set(executionId, prepared.promise);
      void runPersistent(async () => {
        const existing = await store.list(
          meta.user.userId,
          input.targetKind,
          input.targetSandboxId,
        );
        if (!previous && existing.length >= 256) {
          throw new Error("Close unused terminals before creating another");
        }
        const native = await terminals.open({
          kind: input.targetKind,
          sandboxId: input.targetSandboxId,
          sessionId: input.sessionId,
          arguments: input.arguments,
          environment: input.environment,
          workingDir: input.workingDir,
          size: input.size,
          owner: { ...meta.execution, persistentExecutionId: executionId },
        });
        if ("owner" in native) {
          const current = await invoke<{ exited: boolean } | null>({
            ...native.owner,
            function: "terminal.status",
            input: {
              terminalId: native.terminal.id,
              persistentExecutionId: native.owner.persistentExecutionId,
            },
          });
          if (!current) {
            throw new Error("Terminal owner stopped during opening");
          }
          ready.resolve(
            await item(await requireRecord(store, meta, native.terminal.id)),
          );
          return;
        }
        const owner = new TerminalOwner(
          native,
          terminals,
          native.after,
          native.reset,
        );
        const record: TerminalRecord = {
          terminalId: native.terminal.id,
          sessionId: input.sessionId,
          name: previous?.name ?? input.name ?? `Terminal ${input.sessionId}`,
          authenticatedUserId: meta.user.userId,
          targetKind: input.targetKind,
          targetSandboxId: input.targetSandboxId,
          nodeId: meta.execution.nodeId,
          ownerSandboxId: meta.execution.sandboxId,
          workerId: meta.execution.workerId,
          persistentExecutionId: executionId,
          createdAt: previous?.createdAt ?? new Date(),
        };
        const entry = { record, owner, completion: completed.promise };
        owners.set(executionId, entry);
        const running = owner.run();
        void running.catch(() => {});
        let accepted = false;
        try {
          await store.create(record);
          const terminal = await item(record);
          prepared.resolve(entry);
          ready.resolve(terminal);
          accepted = true;
          await running;
        } catch (error) {
          if (!accepted) {
            if (native.reset) {
              // Failed publication must not destroy a shell adopted after Worker loss.
              await terminals.detach(native.attachmentId);
            } else await owner.close();
            await running.catch(() => {});
            await store.remove(record.authenticatedUserId, record.terminalId);
          }
          throw error;
        } finally {
          owners.delete(executionId);
        }
      }).catch((error) => {
        prepared.reject(error);
        ready.reject(error);
        console.error("Terminal display owner stopped", error);
      }).finally(() => {
        opening.delete(executionId);
        completed.resolve();
      });
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
            input: {
              terminalId: record.terminalId,
              persistentExecutionId: record.persistentExecutionId,
            },
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
        }
        await store.remove(meta.user.userId, record.terminalId);
        return Response.json({ closed: true });
      });
    },
  );
  service.get(
    "/status",
    { summary: "Check the retained terminal owner" },
    async ({ meta }) => {
      const entry = await owned(meta);
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
      const entry = await owned(meta);
      return await entry.owner.snapshot(
        new URL(request.url).searchParams.get("view") ?? "",
        request.signal,
      );
    },
  );
  service.websocket("/connect", async ({ meta, socket }) => {
    const entry = await owned(meta);
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
async function owned(meta: RequestMetadata): Promise<Entry> {
  authenticated(meta);
  const entry =
    await (opening.get(persistentId(meta)) ?? owners.get(persistentId(meta)));
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
const OwnerRequest = z.object({
  terminalId: TerminalID,
  persistentExecutionId: z.string().regex(/^pex-[a-z0-9]{10}$/),
}).strict();
async function requestedOwner(input: unknown): Promise<Entry | undefined> {
  const request = OwnerRequest.parse(input);
  const entry = await (opening.get(request.persistentExecutionId) ??
    owners.get(request.persistentExecutionId));
  if (
    entry &&
    (entry.record.terminalId !== request.terminalId ||
      entry.record.authenticatedUserId !== context.userId)
  ) {
    throw new Error("Terminal access was denied");
  }
  return entry;
}
export const workerFunctions = Object.freeze({
  "terminal.status": async (input: unknown) => {
    const entry = await requestedOwner(input);
    return entry?.owner.state() ?? null;
  },
  "terminal.close": async (input: unknown): Promise<{ closed: true }> => {
    const entry = await requestedOwner(input);
    if (!entry) throw new Error("Terminal owner is unavailable");
    await entry.owner.close();
    await entry.completion;
    return { closed: true };
  },
});
