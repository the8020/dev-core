import { development } from "../../src/development.ts";
import type { SchemaPlan } from "/p/the8020/db/mod.ts";
import { context } from "@the8020/context";
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
import { activationChange, developmentInfo } from "../../src/fields.ts";
import layout from "./layouts/main.json" with { type: "json" };
import activationLayout from "./layouts/activation.json" with { type: "json" };
import terminalAssets from "../../terminals/assets.json" with { type: "json" };
import { type ConflictPackage, resolveConflicts } from "./conflicts.ts";
import {
  type ActivationPackagePreview,
  changeLabel,
  reviewPackageChanges,
} from "./changes.ts";

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
    schema_result?: Record<string, { route: string; columns?: string[] }>;
  };
}

const ActivationScreen = z.object({
  packages: field(
    z.array(z.object({
      package: packageId,
      change: activationChange,
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
          await development.sandbox.run("create", developmentUserId);
          status = "Development sandbox created and started";
        } else {
          await development.sandbox.run("start", developmentUserId);
          status = "Development sandbox started";
        }
      }
      if (action === "stop" && sandbox !== undefined) {
        await development.sandbox.run("stop", developmentUserId);
        status = "Development sandbox stopped";
      }
      if (action === "restart" && sandbox !== undefined) {
        await development.sandbox.run("restart", developmentUserId);
        status = "Development sandbox restarted";
      }
      if (action === "reset-source" && sandbox !== undefined) {
        await development.sandbox.run(
          "reset-source",
          developmentUserId,
          { confirm: true },
        );
        status = "Development source reset";
      }
      if (action === "factory-reset" && sandbox !== undefined) {
        await development.sandbox.run(
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
  let status = "";
  let screenModel1: Model<z.infer<typeof ActivationScreen>> | undefined;
  let schemaPlan: SchemaPlan | undefined;
  while (true) {
    let pending: ActivationRunResult["activation"] | undefined;
    let conflicted = false;
    let previewError = "";
    const result: ActivationPreviewResult = { preview: { packages: [] } };
    try {
      const inspected = await development.sandbox.run("inspect", userId);
      pending = (inspected.sandbox as {
        last_activation_result?: ActivationRunResult["activation"];
      }).last_activation_result;
      conflicted = pending?.status === "conflicted" &&
        !!pending.packages?.some((item) => item.conflict_worktree);
      if (!conflicted) {
        result.preview = await development.activate.preview({
          user_id: userId,
        }) as ActivationPreviewResult["preview"];
      }
    } catch (error) {
      previewError = error instanceof Error ? error.message : String(error);
      sendMessage(previewError, "error");
    }
    const packages = result.preview.packages.map((item) => ({
      package: item.package_id,
      change: changeLabel(item.change),
      changedFiles: item.changed_files,
      addedRows: item.added_rows,
      removedRows: item.removed_rows,
      ready: item.activation_ready ? "Ready" : "Blocked",
    }));
    const model: z.infer<typeof ActivationScreen> = {
      packages,
      message,
      status: previewError || status ||
        (!conflicted && packages.length === 0
          ? "No private changes"
          : "Review the changed packages and enter a commit message."),
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
          ...(schemaPlan?.tables.some((t) =>
              t.affected_columns.some((c) => c.repair !== "unsupported")
            )
            ? [{
              id: "force",
              label: "Force activation…",
              kind: "danger" as const,
            }]
            : []),
          { id: "refresh", label: "Refresh" },
        ],
      },
    });
    message = model.message;
    if (!previewError) status = model.status;
    if (event.action === BACK_EVENT) return;
    if (event.action === "change" || event.action === "refresh") {
      schemaPlan = undefined;
      continue;
    }
    if (event.action === "select" && typeof event.value === "string") {
      const selected = result.preview.packages.find((item) =>
        item.package_id === event.value
      );
      if (selected) {
        await presentPage(() => reviewPackageChanges(userId, selected));
      }
    }
    if (
      event.action === "sync-all" || event.action === "resolve" ||
      event.action === "force"
    ) {
      if (message.trim() === "") {
        status = "A commit message is required";
        sendMessage(status, "error");
        continue;
      }
      try {
        const selected = result.preview.packages.filter((p) =>
          p.activation_ready
        ).map((p) => p.package_id);
        let force: string[] = [];
        let approved: string | undefined;
        if (event.action === "force") {
          const preview = await development.activate.preview({
            user_id: userId,
            message: message.trim(),
            packages: selected.join(","),
            schema_preview: true,
            metadata: JSON.stringify({ client: "uui" }),
          });
          schemaPlan = preview.schema_plan as SchemaPlan;
          if (
            !schemaPlan ||
            !schemaPlan.tables.some((t) =>
              t.affected_columns.some((c) => c.repair !== "unsupported")
            )
          ) {
            status = "No legal automatic column repair is available";
            continue;
          }
          if (!(await confirmForce(schemaPlan, message.trim()))) continue;
          force = schemaPlan.tables.flatMap((t) =>
            t.affected_columns.filter((c) => c.repair !== "unsupported").map((
              c,
            ) => `${t.table_id}.${c.name}`)
          );
          approved = schemaPlan.identity;
        }
        if (
          event.action === "resolve" && pending &&
          !(await presentPage(() => resolveConflicts(userId, pending.packages)))
        ) continue;
        let activation: ActivationRunResult["activation"];
        while (true) {
          activation = await development.activate.run({
            user_id: userId,
            message: message.trim(),
            metadata: JSON.stringify({ client: "uui" }),
            packages: selected.join(","),
            force_columns: force.join(","),
            approved_plan: approved,
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
        schemaPlan = undefined;
        status = "All package changes activated";
        if (activation.schema_result) {
          status += ". " +
            Object.entries(activation.schema_result).map(([table, receipt]) =>
              `${table}: ${
                receipt.route === "repair"
                  ? `incompatible cells repaired (${
                    receipt.columns?.join(", ") ?? "authorized columns"
                  })`
                  : receipt.route === "cleanup"
                  ? "cleanup and schema applied"
                  : "schema applied"
              }`
            ).join("; ");
        }
        sendMessage(status, "success");
      } catch (error) {
        status = error instanceof Error ? error.message : String(error);
        sendMessage(status, "error");
        try {
          const preview = await development.activate.preview({
            user_id: userId,
            message: message.trim(),
            packages: result.preview.packages.filter((p) => p.activation_ready)
              .map((p) => p.package_id).join(","),
            schema_preview: true,
            metadata: JSON.stringify({ client: "uui" }),
          });
          schemaPlan = preview.schema_plan as SchemaPlan | undefined;
        } catch {
          schemaPlan = undefined;
        }
      }
    }
  }
}

async function confirmForce(
  plan: SchemaPlan,
  message: string,
): Promise<boolean> {
  return await presentModal(async () => {
    const model = new Model({ confirmed: false });
    const tables = plan.tables.filter((t) => t.route !== "automatic");
    while (true) {
      const event = await callScreen({
        id: "development-force-confirm",
        title: "Force activation?",
        description: `Commit: ${message}\n\n${
          tables.flatMap((t) =>
            t.affected_columns.filter((c) => c.repair !== "unsupported").map((
              c,
            ) =>
              `${t.table_id}.${c.name}: only incompatible cells may become ${
                c.repair === "null" ? "NULL" : "the authored target default"
              }. Other values, rows, keys and identities are retained.`
            )
          ).join("\n")
        }\nCleanup and native activation run first. Unsupported repairs stop without clearing a table.`,
        schema: z.object({
          confirmed: field(z.boolean(), {
            label: "Repair incompatible cells in the listed columns",
          }),
        }),
        model,
        header: {
          actions: [
            { id: "force", label: "Force activation", kind: "danger" },
            { id: "cancel", label: "Cancel" },
          ],
        },
      });
      if (event.action === BACK_EVENT || event.action === "cancel") {
        return false;
      }
      if (event.action === "force" && model.data.confirmed) return true;
      if (event.action === "force") {
        sendMessage("Confirm column repair before force activation.", "error");
      }
    }
  });
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
    await development.sandbox.run("create", userId);
    return "Development sandbox created and started";
  }
  await development.sandbox.run("start", userId);
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
  return await development.sandbox.list() as DevelopmentSandbox[];
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
