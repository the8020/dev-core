import { context } from "@the8020/context";
import { kernel } from "@the8020/kernel";
import {
  BACK_EVENT,
  callScreen,
  currentBrowser,
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
import { developmentInfo } from "../../src/fields.ts";
import layout from "./layouts/main.json" with { type: "json" };
import activationLayout from "./layouts/activation.json" with { type: "json" };
import terminalAssets from "../../terminals/assets.json" with { type: "json" };
import { type ConflictPackage, resolveConflicts } from "./conflicts.ts";

interface DevelopmentSandbox {
  user_id: string;
  sandbox_id: string;
  state: string;
}

interface DevelopmentScreenModel {
  user: string;
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
    error?: string;
    packages: ConflictPackage[];
  };
}

const ActivationScreen = z.object({
  packages: field(
    z.array(z.object({
      package: packageId,
      changedFiles: developmentInfo.shape.changedFiles,
      addedRows: developmentInfo.shape.addedRows,
      removedRows: developmentInfo.shape.removedRows,
      ready: developmentInfo.shape.ready,
    })),
    {
      label: "Changed packages",
      description:
        "Review changed files and line counts for each package before activation.",
      control: "list",
      readOnly: true,
    },
  ),
  message: field(developmentInfo.shape.message, {
    control: "textarea",
    length: "long",
    rowSpan: 2,
  }),
  status: field(developmentInfo.shape.activationStatus, {
    length: "long",
    readOnly: true,
  }),
});

export default async function developmentTest(): Promise<void> {
  if (!context.authenticated) throw new Error("authenticated user is required");
  const developmentUserId = context.username;
  let status = await startDevelopmentSandbox(developmentUserId);
  let terminalRefresh = 0;
  let screenModel: Model<DevelopmentScreenModel> | undefined;
  while (true) {
    const sandboxes = await developmentSandboxes();
    const sandbox = sandboxes.find((item) =>
      item.user_id === developmentUserId
    );
    const running = sandbox !== undefined && isRunning(sandbox);
    const sandboxId = sandbox?.sandbox_id ?? "";
    const Screen = z.object({
      user: field(username, { readOnly: true }),
      sandboxId: field(developmentInfo.shape.sandboxId, {
        length: "long",
        control: "text",
        readOnly: true,
      }),
      state: field(developmentInfo.shape.state, {
        length: "short",
        control: "text",
        readOnly: true,
      }),
      status: field(developmentInfo.shape.status, {
        length: "long",
        control: "text",
        readOnly: true,
      }),
    });
    const model: DevelopmentScreenModel = {
      user: developmentUserId,
      sandboxId: sandbox?.sandbox_id ?? sandboxId,
      state: sandbox?.state ?? "ABSENT",
      status,
    };
    screenModel ??= new Model(model);
    screenModel.data = model;
    const actions = actionsFor(sandbox);
    const screenLayout = structuredClone(layout);
    const settingsActions = layout.root.children.flatMap((node) =>
      node.actions ?? []
    );
    for (const node of screenLayout.root.children) {
      if (node.actions) {
        node.actions = node.actions.filter((id) =>
          actions.some((a) => a.id === id)
        );
      }
    }
    const event = await callScreen({
      id: "development-test",
      title: "Development",
      description: sshHint(developmentUserId),
      schema: Screen,
      model: screenModel,
      layout: screenLayout,
      actions: actions.filter((action) => settingsActions.includes(action.id)),
      customElements: [{
        id: "sandbox-console",
        module: packageAssetURL("the8020/dev-core", terminalAssets.module),
        styles: terminalAssets.styles.map((path) =>
          packageAssetURL("the8020/dev-core", path)
        ),
        preserve: true,
        config: {
          ...consoleConfiguration(sandboxId, running),
          refresh: terminalRefresh,
        },
      }],
      header: {
        actions: actions.filter((action) =>
          !settingsActions.includes(action.id)
        ),
      },
    });
    const action = event.action;
    if (event.action === BACK_EVENT) return;
    if (event.action === "change") continue;
    if (event.action === "refresh") {
      terminalRefresh++;
      status = "Refreshed";
      continue;
    }
    if (event.action === "activate" && sandbox !== undefined) {
      await presentPage(() => activateChanges(developmentUserId));
      continue;
    }
    if (
      (action === "reset-source" || action === "factory-reset") &&
      !(await confirmReset(action === "factory-reset"))
    ) {
      continue;
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
    const inspected = await kernel.development.sandbox.run("inspect", userId);
    const pending = (inspected.sandbox as {
      last_activation_result?: ActivationRunResult["activation"];
    }).last_activation_result;
    const conflicted = pending?.status === "conflicted" &&
      pending.packages?.some((item) => item.conflict_worktree);
    const result = {
      preview: conflicted
        ? { packages: [] }
        : await kernel.development.activate.preview({ user_id: userId }),
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
      status: !conflicted && packages.length === 0
        ? "No private changes"
        : status,
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
          ...(conflicted
            ? [{
              id: "resolve",
              label: "Resolve conflicts",
              kind: "primary" as const,
            }]
            : []),
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
    if (event.action === "sync-all" || event.action === "resolve") {
      if (message.trim() === "") {
        status = "A commit message is required";
        sendMessage(status, "error");
        continue;
      }
      try {
        if (
          event.action === "resolve" && pending &&
          !(await presentPage(() => resolveConflicts(userId, pending.packages)))
        ) continue;
        let activation: ActivationRunResult["activation"];
        while (true) {
          activation = await kernel.development.activate.run({
            user_id: userId,
            message: message.trim(),
            metadata: JSON.stringify({ client: "uui" }),
          }) as ActivationRunResult["activation"];
          if (
            activation.status === "conflicted" &&
            activation.packages?.some((item) => item.conflict_worktree) &&
            await presentPage(() =>
              resolveConflicts(userId, activation.packages)
            )
          ) continue;
          break;
        }
        if (!activation.success) {
          throw new Error(
            activation.error ?? `Activation ${activation.status}`,
          );
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

async function confirmReset(factory: boolean): Promise<boolean> {
  return await presentModal(async () => {
    const confirm = new Model({ confirmed: false });
    while (true) {
      const response = await callScreen({
        id: "development-reset-confirm",
        title: factory ? "Factory reset?" : "Reset source?",
        description: factory
          ? "This deletes your source changes, root home directory, and installed system changes."
          : "This deletes your unactivated source changes. Your root home directory and installed system changes are kept.",
        schema: z.object({
          confirmed: developmentInfo.shape.confirmed,
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
}

function sshHint(user: string): string | undefined {
  const browser = currentBrowser();
  if (!browser) return;
  const destination = `${user}@${new URL(browser.origin).hostname}`;
  const argument = /^[a-zA-Z0-9_.@:[\]-]+$/.test(destination)
    ? destination
    : `'${destination.replaceAll("'", "'\\''")}'`;
  const command = `ssh -p 22 -- ${argument}`;
  const fence = "`".repeat(
    1 + Math.max(
      0,
      ...Array.from(command.matchAll(/`+/g), (match) => match[0].length),
    ),
  );
  return `SSH: ${fence} ${command} ${fence} or ${fence} ssh -t -p 22 -- ${argument} the8020 terminal-id XYZ ${fence} for a specific persistent session.`;
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
    ...(running ? [{ id: "restart", label: "Restart sandbox" }] : []),
    ...(sandbox === undefined ? [] : [
      { id: "reset-source", label: "Reset source", kind: "danger" as const },
      { id: "factory-reset", label: "Factory reset", kind: "danger" as const },
    ]),
    { id: "refresh", label: "Refresh" },
  ];
}
