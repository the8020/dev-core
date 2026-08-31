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
  active_sandbox_id?: string;
  state: string;
}

interface DevelopmentListResult extends Record<string, unknown> {
  workspaces: Workspace[];
}

interface RuntimeSandbox {
  sandbox_id: string;
  workload_type: string;
  state: string;
}

interface SandboxListResult extends Record<string, unknown> {
  sandboxes: RuntimeSandbox[];
}

interface Target {
  value: string;
  label: string;
  kind: "runtime" | "development";
  sandboxId: string;
}

interface DevelopmentScreenModel {
  workspaceId: string;
  state: string;
  activeSandboxId: string;
  status: string;
  confirmDestructive: boolean;
  target: string;
}

export default async function developmentTest(): Promise<void> {
  const user = await kernel.auth.currentUser();
  if (user === undefined) throw new Error("authenticated user is required");
  const developmentUserId = user.username;
  let selectedTarget = "";
  let status = await startDevelopmentSandbox(developmentUserId);
  let confirmDestructive = false;
  while (true) {
    const workspaces = await developmentWorkspaces();
    const workspace = workspaces.find((item) =>
      item.owner_user_id === developmentUserId
    );
    const targets = await consoleTargets(workspaces);
    if (!targets.some((item) => item.value === selectedTarget)) {
      selectedTarget = workspace?.active_sandbox_id === undefined
        ? targets[0]?.value ?? ""
        : `development:${workspace.active_sandbox_id}`;
      if (!targets.some((item) => item.value === selectedTarget)) {
        selectedTarget = targets[0]?.value ?? "";
      }
    }
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
          "Required for source reset or factory reset. Source reset preserves persistent home and installed system changes; factory reset deletes both.",
        control: "checkbox",
        hidden: workspace === undefined,
      }),
      target: field(z.string(), {
        label: "Running sandbox",
        length: "long",
        description:
          "Current bootstrap users are administrators and may open a console in any running local sandbox.",
        control: "select",
        reactive: true,
        options: targets.map((item) => ({
          value: item.value,
          label: item.label,
        })),
      }),
    });
    const model: DevelopmentScreenModel = {
      workspaceId: workspace?.workspace_id ?? "Not created",
      state: workspace?.state ?? "ABSENT",
      activeSandboxId: workspace?.active_sandbox_id ?? "",
      status,
      confirmDestructive,
      target: selectedTarget,
    };
    const selected = targets.find((item) => item.value === selectedTarget);
    const event = await callScreen({
      id: "development-test",
      title: "Development test",
      description:
        "Control your development sandbox and open a credentialless Bash PTY in any running local sandbox.",
      schema: Screen,
      model,
      layout,
      customElements: [{
        id: "sandbox-console",
        initializer: "sandbox-console.v1",
        preserve: true,
        config: consoleConfiguration(selected),
      }],
      header: {
        controls: [{ id: "target", bind: "target" }],
        actions: actionsFor(workspace),
      },
    });
    selectedTarget = model.target;
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
          selectedTarget = "";
          status = "Development sandbox created and started";
        } else {
          await kernel.admin.execute("development.sandbox.start", {
            workspace_id: workspace.workspace_id,
          });
          selectedTarget = "";
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
        selectedTarget = "";
        confirmDestructive = false;
        status = "Development source reset";
      }
      if (event.action === "factory-reset" && workspace !== undefined) {
        requireDestructiveConfirmation(confirmDestructive);
        await kernel.admin.execute("development.sandbox.factory_reset", {
          workspace_id: workspace.workspace_id,
          confirm: true,
        });
        selectedTarget = "";
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
    workspace?.active_sandbox_id !== undefined &&
    (workspace.state === "READY" || workspace.state === "CONFLICTED")
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

async function consoleTargets(workspaces: Workspace[]): Promise<Target[]> {
  const result: Target[] = workspaces.flatMap((workspace) =>
    workspace.active_sandbox_id === undefined ||
      (workspace.state !== "READY" && workspace.state !== "CONFLICTED")
      ? []
      : [{
        value: `development:${workspace.active_sandbox_id}`,
        label:
          `Development · ${workspace.owner_user_id} · ${workspace.active_sandbox_id}`,
        kind: "development" as const,
        sandboxId: workspace.active_sandbox_id,
      }]
  );
  try {
    const runtime = await kernel.admin.execute<SandboxListResult>(
      "sandbox.list",
    );
    for (const sandbox of runtime.sandboxes) {
      if (sandbox.state !== "READY") continue;
      result.push({
        value: `runtime:${sandbox.sandbox_id}`,
        label: `Runtime · ${sandbox.workload_type} · ${sandbox.sandbox_id}`,
        kind: "runtime",
        sandboxId: sandbox.sandbox_id,
      });
    }
  } catch {
    // Development workspaces remain usable while runtime initialization fails.
  }
  return result.sort((left, right) => left.label.localeCompare(right.label));
}

function consoleConfiguration(target: Target | undefined) {
  const development = target?.kind === "development";
  return {
    enabled: target !== undefined,
    websocketPath: "/_the8020/console",
    target: {
      kind: target?.kind ?? "development",
      sandboxId: target?.sandboxId ?? "unavailable",
    },
    arguments: ["/bin/bash", "-l"],
    environment: [
      "TERM=xterm-256color",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      `HOME=${development ? "/home/developer" : "/tmp"}`,
    ],
    workingDirectory: development ? "/workspace" : "/",
  };
}

function actionsFor(workspace: Workspace | undefined) {
  const running = workspace?.active_sandbox_id !== undefined &&
    (workspace.state === "READY" || workspace.state === "CONFLICTED");
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
