import { kernel } from "@the8020/kernel";
import {
  BACK_EVENT,
  callScreen,
  field,
  showNotification,
  z,
} from "@packages/the8020/uui/mod.ts";
import layout from "./layouts/main.json" with { type: "json" };

interface Workspace {
  workspace_id: string;
  owner_user_id: string;
  state: string;
}

interface DevelopmentListResult extends Record<string, unknown> {
  workspaces: Workspace[];
}

interface DevelopmentScreenModel {
  workspaceId: string;
  state: string;
  activeSandboxId: string;
  status: string;
  confirmDestructive: boolean;
}

export default async function developmentTest(): Promise<void> {
  const user = await kernel.auth.currentUser();
  if (user === undefined) throw new Error("authenticated user is required");
  const developmentUserId = user.username;
  const sandboxId = `dev-${developmentUserId}`;
  let status = await startDevelopmentSandbox(developmentUserId);
  let confirmDestructive = false;
  while (true) {
    const workspaces = await developmentWorkspaces();
    const workspace = workspaces.find((item) =>
      item.owner_user_id === developmentUserId
    );
    const running = workspace !== undefined && isRunning(workspace);
    const Screen = z.object({
      workspaceId: field(z.string(), {
        label: "Workspace",
        length: "long",
        control: "text",
        readOnly: true,
      }),
      state: field(z.string(), {
        label: "State",
        length: "short",
        control: "text",
        readOnly: true,
      }),
      activeSandboxId: field(z.string(), {
        label: "Active sandbox",
        length: "long",
        control: "text",
        readOnly: true,
      }),
      status: field(z.string(), {
        label: "Last operation",
        length: "long",
        control: "text",
        readOnly: true,
      }),
      confirmDestructive: field(z.boolean(), {
        label: "Confirm destructive reset",
        length: "short",
        description:
          "Required for source reset or factory reset. Source reset preserves /root and installed system changes; factory reset deletes both.",
        control: "checkbox",
        hidden: workspace === undefined,
      }),
    });
    const model: DevelopmentScreenModel = {
      workspaceId: workspace?.workspace_id ?? "Not created",
      state: workspace?.state ?? "ABSENT",
      activeSandboxId: running ? sandboxId : "",
      status,
      confirmDestructive,
    };
    const event = await callScreen({
      id: "development-test",
      title: "Development test",
      description:
        `Connect from your own terminal with ssh ${developmentUserId}@localhost -p 22. Change the hostname or port when 80|20 is containerized, behind a proxy, or published through different port mappings.`,
      schema: Screen,
      model,
      layout,
      customElements: [{
        id: "sandbox-console",
        initializer: "sandbox-console.v1",
        preserve: true,
        config: consoleConfiguration(sandboxId, running),
      }],
      header: {
        actions: actionsFor(workspace),
      },
    });
    confirmDestructive = model.confirmDestructive;
    if (event.action === BACK_EVENT) return;
    if (event.action === "change") continue;
    if (event.action === "refresh") {
      status = "Refreshed";
      continue;
    }
    try {
      if (event.action === "start") {
        if (workspace === undefined) {
          await kernel.admin.execute("development.sandbox.create", {
            user_id: developmentUserId,
          });
          status = "Development sandbox created and started";
        } else {
          await kernel.admin.execute("development.sandbox.start", {
            workspace_id: workspace.workspace_id,
          });
          status = "Development sandbox started";
        }
      }
      if (event.action === "stop" && workspace !== undefined) {
        await kernel.admin.execute("development.sandbox.stop", {
          workspace_id: workspace.workspace_id,
        });
        status = "Development sandbox stopped";
      }
      if (event.action === "restart" && workspace !== undefined) {
        await kernel.admin.execute("development.sandbox.restart", {
          workspace_id: workspace.workspace_id,
        });
        status = "Development sandbox restarted";
      }
      if (event.action === "reset-source" && workspace !== undefined) {
        requireDestructiveConfirmation(confirmDestructive);
        await kernel.admin.execute("development.sandbox.reset_source", {
          workspace_id: workspace.workspace_id,
          confirm: true,
        });
        confirmDestructive = false;
        status = "Development source reset";
      }
      if (event.action === "factory-reset" && workspace !== undefined) {
        requireDestructiveConfirmation(confirmDestructive);
        await kernel.admin.execute("development.sandbox.factory_reset", {
          workspace_id: workspace.workspace_id,
          confirm: true,
        });
        confirmDestructive = false;
        status = "Development workspace factory reset";
      }
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      showNotification(status, "error");
    }
  }
}

async function startDevelopmentSandbox(userId: string): Promise<string> {
  const workspace = (await developmentWorkspaces()).find((item) =>
    item.owner_user_id === userId
  );
  if (
    workspace !== undefined && isRunning(workspace)
  ) {
    return "Ready";
  }
  if (workspace === undefined) {
    await kernel.admin.execute("development.sandbox.create", {
      user_id: userId,
    });
    return "Development sandbox created and started";
  }
  await kernel.admin.execute("development.sandbox.start", {
    workspace_id: workspace.workspace_id,
  });
  return "Development sandbox started";
}

function requireDestructiveConfirmation(confirmed: boolean): void {
  if (!confirmed) {
    throw new Error(
      "Select Confirm destructive reset before resetting the workspace",
    );
  }
}

async function developmentWorkspaces(): Promise<Workspace[]> {
  const result = await kernel.admin.execute<DevelopmentListResult>(
    "development.sandbox.list",
  );
  return result.workspaces;
}

function isRunning(workspace: Workspace): boolean {
  return workspace.state === "READY" || workspace.state === "CONFLICTED";
}

function consoleConfiguration(sandboxId: string, enabled: boolean) {
  return {
    enabled,
    websocketPath: "/_the8020/console",
    target: {
      kind: "development",
      sandboxId,
    },
    arguments: ["/bin/bash", "-l"],
    environment: [
      "TERM=xterm-256color",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOME=/root",
    ],
    workingDirectory: "/workspace",
  };
}

function actionsFor(workspace: Workspace | undefined) {
  const running = workspace !== undefined && isRunning(workspace);
  return [
    ...(!running
      ? [{ id: "start", label: "Start sandbox", kind: "primary" as const }]
      : [
        { id: "stop", label: "Stop sandbox", kind: "danger" as const },
        { id: "restart", label: "Restart sandbox" },
      ]),
    ...(workspace === undefined ? [] : [
      { id: "reset-source", label: "Reset source", kind: "danger" as const },
      {
        id: "factory-reset",
        label: "Factory reset",
        kind: "danger" as const,
      },
    ]),
    { id: "refresh", label: "Refresh" },
  ];
}
