import { currentUser } from "/p/the8020/users/mod.ts";
import { kernel } from "@the8020/kernel";
import {
  BACK_EVENT,
  callScreen,
  field,
  Model,
  sendMessage,
  z,
} from "/p/the8020/uui/mod.ts";
import layout from "./layouts/main.json" with { type: "json" };
import activationLayout from "./layouts/activation.json" with { type: "json" };

interface DevelopmentSandbox {
  user_id: string;
  sandbox_id: string;
  state: string;
}

interface DevelopmentScreenModel {
  sandboxId: string;
  state: string;
  status: string;
  confirmDestructive: boolean;
}

interface ActivationPackagePreview {
  package_id: string;
  changed_files: number;
  added_rows: number;
  removed_rows: number;
  activation_ready: boolean;
}

interface ActivationPreviewResult extends Record<string, unknown> {
  preview: {
    packages: ActivationPackagePreview[];
  };
}

interface ActivationRunResult extends Record<string, unknown> {
  activation: {
    success: boolean;
    status: string;
  };
}

const ActivationScreen = z.object({
  packages: field(
    z.array(z.object({
      package: z.string(),
      changedFiles: z.number(),
      addedRows: z.number(),
      removedRows: z.number(),
      ready: z.string(),
    })),
    {
      label: "Changed packages",
      control: "list",
      readOnly: true,
    },
  ),
  message: field(z.string(), {
    label: "Commit message",
    description:
      "Required. The same message is used for every changed package in this activation.",
    control: "textarea",
    length: "long",
    rowSpan: 2,
  }),
  status: field(z.string(), {
    label: "Activation status",
    length: "long",
    readOnly: true,
  }),
});

export default async function developmentTest(): Promise<void> {
  const user = currentUser();
  if (user === undefined) throw new Error("authenticated user is required");
  const developmentUserId = user.username;
  const sandboxId = `dev-${developmentUserId}`;
  let status = await startDevelopmentSandbox(developmentUserId);
  let confirmDestructive = false;
  let screenModel: Model<DevelopmentScreenModel> | undefined;
  while (true) {
    const sandboxes = await developmentSandboxes();
    const sandbox = sandboxes.find((item) =>
      item.user_id === developmentUserId
    );
    const running = sandbox !== undefined && isRunning(sandbox);
    const Screen = z.object({
      sandboxId: field(z.string(), {
        label: "Sandbox",
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
        hidden: sandbox === undefined,
      }),
    });
    const model: DevelopmentScreenModel = {
      sandboxId: sandbox?.sandbox_id ?? sandboxId,
      state: sandbox?.state ?? "ABSENT",
      status,
      confirmDestructive,
    };
    screenModel ??= new Model(model);
    screenModel.data = model;
    const event = await callScreen({
      id: "development-test",
      title: "Development test",
      description:
        `Connect from your own terminal with ssh ${developmentUserId}@localhost -p 22. Change the hostname or port when 80|20 is containerized, behind a proxy, or published through different port mappings.`,
      schema: Screen,
      model: screenModel,
      layout,
      customElements: [{
        id: "sandbox-console",
        initializer: "sandbox-console.v1",
        preserve: true,
        config: consoleConfiguration(sandboxId, running),
      }],
      header: {
        actions: actionsFor(sandbox),
      },
    });
    confirmDestructive = model.confirmDestructive;
    if (event.action === BACK_EVENT) return;
    if (event.action === "change") continue;
    if (event.action === "refresh") {
      status = "Refreshed";
      continue;
    }
    if (event.action === "activate" && sandbox !== undefined) {
      await activateChanges(developmentUserId);
      status = "Activation screen closed";
      continue;
    }
    try {
      if (event.action === "start") {
        if (sandbox === undefined) {
          await kernel.development.sandbox.run("create", developmentUserId);
          status = "Development sandbox created and started";
        } else {
          await kernel.development.sandbox.run("start", developmentUserId);
          status = "Development sandbox started";
        }
      }
      if (event.action === "stop" && sandbox !== undefined) {
        await kernel.development.sandbox.run("stop", developmentUserId);
        status = "Development sandbox stopped";
      }
      if (event.action === "restart" && sandbox !== undefined) {
        await kernel.development.sandbox.run("restart", developmentUserId);
        status = "Development sandbox restarted";
      }
      if (event.action === "reset-source" && sandbox !== undefined) {
        requireDestructiveConfirmation(confirmDestructive);
        await kernel.development.sandbox.run(
          "reset-source",
          developmentUserId,
          { confirm: true },
        );
        confirmDestructive = false;
        status = "Development source reset";
      }
      if (event.action === "factory-reset" && sandbox !== undefined) {
        requireDestructiveConfirmation(confirmDestructive);
        await kernel.development.sandbox.run(
          "factory-reset",
          developmentUserId,
          { confirm: true },
        );
        confirmDestructive = false;
        status = "Development sandbox factory reset";
      }
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      sendMessage(status, "error");
    }
  }
}

async function activateChanges(userId: string): Promise<void> {
  let message = "";
  let status = "Review all private package changes before activation";
  let screenModel1: Model<z.infer<typeof ActivationScreen>> | undefined;
  while (true) {
    const result = {
      preview: await kernel.development.activate.preview({ user_id: userId }),
    } as ActivationPreviewResult;
    const packages = result.preview.packages.map((item) => ({
      package: item.package_id,
      changedFiles: item.changed_files,
      addedRows: item.added_rows,
      removedRows: item.removed_rows,
      ready: item.activation_ready ? "Ready" : "Blocked",
    }));
    const model: z.infer<typeof ActivationScreen> = {
      packages,
      message,
      status: packages.length === 0 ? "No private changes" : status,
    };
    screenModel1 ??= new Model(model);
    screenModel1.data = model;
    const event = await callScreen({
      id: "development-activation",
      title: "Activate development changes",
      description:
        "Commit every changed package independently, publish the private deltas to shared sources, and reset the sandbox overlay.",
      schema: ActivationScreen,
      model: screenModel1,
      layout: activationLayout,
      header: {
        actions: [
          ...(packages.length > 0
            ? [{
              id: "sync-all",
              label: "Sync all changes",
              kind: "primary" as const,
            }]
            : []),
          { id: "refresh", label: "Refresh" },
        ],
      },
    });
    message = model.message;
    status = model.status;
    if (event.action === BACK_EVENT) return;
    if (event.action === "change" || event.action === "refresh") continue;
    if (event.action === "sync-all") {
      if (message.trim() === "") {
        status = "A commit message is required";
        sendMessage(status, "error");
        continue;
      }
      try {
        const activation = {
          activation: await kernel.development.activate.run({
            user_id: userId,
            message: message.trim(),
            metadata: JSON.stringify({ client: "uui" }),
          }),
        } as ActivationRunResult;
        if (!activation.activation.success) {
          throw new Error(`Activation ${activation.activation.status}`);
        }
        message = "";
        status = "All package changes activated and the overlay was reset";
        sendMessage(status, "success");
      } catch (error) {
        status = error instanceof Error ? error.message : String(error);
        sendMessage(status, "error");
      }
    }
  }
}

async function startDevelopmentSandbox(userId: string): Promise<string> {
  const sandbox = (await developmentSandboxes()).find((item) =>
    item.user_id === userId
  );
  if (
    sandbox !== undefined && isRunning(sandbox)
  ) {
    return "Ready";
  }
  if (sandbox === undefined) {
    await kernel.development.sandbox.run("create", userId);
    return "Development sandbox created and started";
  }
  await kernel.development.sandbox.run("start", userId);
  return "Development sandbox started";
}

function requireDestructiveConfirmation(confirmed: boolean): void {
  if (!confirmed) {
    throw new Error(
      "Select Confirm destructive reset before resetting the sandbox",
    );
  }
}

async function developmentSandboxes(): Promise<DevelopmentSandbox[]> {
  return await kernel.development.sandbox.list() as DevelopmentSandbox[];
}

function isRunning(sandbox: DevelopmentSandbox): boolean {
  return sandbox.state === "READY" || sandbox.state === "CONFLICTED";
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
      "PATH=/workspace/scripts:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOME=/root",
    ],
    workingDirectory: "/workspace",
  };
}

function actionsFor(sandbox: DevelopmentSandbox | undefined) {
  const running = sandbox !== undefined && isRunning(sandbox);
  return [
    ...(!running
      ? [{ id: "start", label: "Start sandbox", kind: "primary" as const }]
      : [
        { id: "activate", label: "Activate changes", kind: "primary" as const },
        { id: "stop", label: "Stop sandbox", kind: "danger" as const },
        { id: "restart", label: "Restart sandbox" },
      ]),
    ...(sandbox === undefined ? [] : [
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
