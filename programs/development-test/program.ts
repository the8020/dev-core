import { currentUser } from "/p/the8020/users/mod.ts";
import { kernel } from "@the8020/kernel";
import {
  BACK_EVENT,
  callScreen,
  field,
  Model,
  packageAssetURL,
  presentModal,
  presentPage,
  sendMessage,
  z,
} from "/p/the8020/uui/mod.ts";
import { packageId } from "/p/the8020/packages/types/package.ts";
import { username } from "/p/the8020/users/types/user.ts";
import layout from "./layouts/main.json" with { type: "json" };
import activationLayout from "./layouts/activation.json" with { type: "json" };
import terminalAssets from "../../terminals/assets.json" with { type: "json" };

interface DevelopmentSandbox {
  user_id: string;
  sandbox_id: string;
  state: string;
}

interface DevelopmentScreenModel {
  sandboxId: string;
  state: string;
  status: string;
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
      package: packageId,
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
  let status = await startDevelopmentSandbox(developmentUserId);
  let screenModel: Model<DevelopmentScreenModel> | undefined;
  while (true) {
    const sandboxes = await developmentSandboxes();
    const sandbox = sandboxes.find((item) =>
      item.user_id === developmentUserId
    );
    const running = sandbox !== undefined && isRunning(sandbox);
    const sandboxId = sandbox?.sandbox_id ?? "";
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
    });
    const model: DevelopmentScreenModel = {
      sandboxId: sandbox?.sandbox_id ?? sandboxId,
      state: sandbox?.state ?? "ABSENT",
      status,
    };
    screenModel ??= new Model(model);
    screenModel.data = model;
    const event = await callScreen({
      id: "development-test",
      title: "Development",
      schema: Screen,
      model: screenModel,
      layout,
      customElements: [{
        id: "sandbox-console",
        module: packageAssetURL("the8020/dev-core", terminalAssets.module),
        styles: terminalAssets.styles.map((path) =>
          packageAssetURL("the8020/dev-core", path)
        ),
        preserve: true,
        config: consoleConfiguration(sandboxId, running),
      }],
      header: {
        actions: actionsFor(sandbox),
      },
    });
    let action = event.action;
    if (event.action === BACK_EVENT) return;
    if (event.action === "change") continue;
    if (event.action === "refresh") {
      status = "Refreshed";
      continue;
    }
    if (event.action === "activate" && sandbox !== undefined) {
      await presentPage(() => activateChanges(developmentUserId));
      continue;
    }
    if (action === "advanced" && sandbox !== undefined) {
      const selected = await presentPage(() =>
        advancedSandbox(developmentUserId, sandbox)
      );
      if (!selected) continue;
      action = selected;
    }
    try {
      if (action === "start") {
        if (sandbox === undefined) {
          await kernel.development.sandbox.run("create", developmentUserId);
          status = "Development sandbox created and started";
        } else {
          await kernel.development.sandbox.run("start", developmentUserId);
          status = "Development sandbox started";
        }
      }
      if (action === "stop" && sandbox !== undefined) {
        await kernel.development.sandbox.run("stop", developmentUserId);
        status = "Development sandbox stopped";
      }
      if (action === "restart" && sandbox !== undefined) {
        await kernel.development.sandbox.run("restart", developmentUserId);
        status = "Development sandbox restarted";
      }
      if (action === "reset-source" && sandbox !== undefined) {
        await kernel.development.sandbox.run(
          "reset-source",
          developmentUserId,
          { confirm: true },
        );
        status = "Development source reset";
      }
      if (action === "factory-reset" && sandbox !== undefined) {
        await kernel.development.sandbox.run(
          "factory-reset",
          developmentUserId,
          { confirm: true },
        );
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
  let status = "Review the changed packages and enter a commit message.";
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
        "Activate your changes for all ready packages. Each package gets a commit with the message below.",
      schema: ActivationScreen,
      model: screenModel1,
      layout: activationLayout,
      header: {
        actions: [
          ...(packages.length > 0
            ? [{
              id: "sync-all",
              label: "Activate all changes",
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
    if (event.action === "select" && typeof event.value === "string") {
      const { default: packages } = await import(
        "/p/the8020/admin-core/programs/packages/program.ts"
      );
      await presentPage(() => packages(event.value as string));
    }
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
        status = "All package changes activated";
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

async function advancedSandbox(
  user: string,
  sandbox: DevelopmentSandbox,
): Promise<string | undefined> {
  const schema = z.object({
    user: field(username, { readOnly: true }),
    sandboxId: field(z.string(), { label: "Sandbox ID", readOnly: true }),
    ssh: field(z.string(), {
      label: "SSH command",
      readOnly: true,
      length: "long",
      description:
        "Replace localhost and port 22 with your server's address and published SSH port.",
    }),
  });
  const model = new Model({
    user,
    sandboxId: sandbox.sandbox_id,
    ssh: `ssh ${user}@localhost -p 22`,
  });
  while (true) {
    const event = await callScreen({
      id: "development-advanced",
      title: "Advanced development settings",
      schema,
      model,
      header: {
        actions: [
          ...(isRunning(sandbox)
            ? [{ id: "restart", label: "Restart sandbox" }]
            : []),
          { id: "reset-source", label: "Reset source", kind: "danger" },
          { id: "factory-reset", label: "Factory reset", kind: "danger" },
        ],
      },
    });
    if (event.action === BACK_EVENT) return;
    if (event.action === "restart") return event.action;
    if (event.action !== "reset-source" && event.action !== "factory-reset") {
      continue;
    }
    const factory = event.action === "factory-reset";
    const confirmed = await presentModal(async () => {
      const confirm = new Model({ confirmed: false });
      while (true) {
        const response = await callScreen({
          id: "development-reset-confirm",
          title: factory ? "Factory reset?" : "Reset source?",
          description: factory
            ? "This deletes your source changes, root home directory, and installed system changes."
            : "This deletes your unactivated source changes. Your root home directory and installed system changes are kept.",
          schema: z.object({
            confirmed: field(z.boolean(), {
              label: "I understand that these changes will be deleted",
            }),
          }),
          model: confirm,
          header: {
            actions: [{
              id: "reset",
              label: factory ? "Factory reset" : "Reset source",
              kind: "danger",
            }, { id: "cancel", label: "Cancel" }],
          },
        });
        if (response.action === BACK_EVENT || response.action === "cancel") {
          return false;
        }
        if (response.action === "reset" && confirm.data.confirmed) return true;
        sendMessage("Confirm deletion before resetting the sandbox.", "error");
      }
    });
    if (confirmed) return event.action;
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
        { id: "activate", label: "Review changes", kind: "primary" as const },
        { id: "stop", label: "Stop sandbox", kind: "danger" as const },
      ]),
    ...(sandbox === undefined ? [] : [{ id: "advanced", label: "Advanced" }]),
    { id: "refresh", label: "Refresh" },
  ];
}
