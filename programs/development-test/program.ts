import { currentLocalization } from "/p/the8020/i18n/mod.ts";
import { text as localizedText } from "/p/the8020/i18n/mod.ts";
import { msg } from "/p/the8020/dev-core/i18n/messages.ts";
import { development } from "../../src/development.ts";
import type { SchemaPlan } from "/p/the8020/db/mod.ts";
import { context } from "@the8020/context";
import {
  BACK_EVENT,
  callScreen,
  CONFIRM_CLASS,
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
import { allowed } from "../../src/authorized.ts";
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
    pending?: ActivationRunResult["activation"];
    retained?: {
      attempt_id: string;
      status: string;
      worktree: string;
      recovery?: string;
    }[];
    inventory_truncated?: boolean;
  };
}

interface ActivationRunResult extends Record<string, unknown> {
  activation: {
    success: boolean;
    status: string;
    error?: string;
    resumed?: boolean;
    phase?: string;
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
      label: msg("program.changed_packages"),
      description: msg("program.review_changed_files_and_line_counts_for"),
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
  if (!await allowed("the8020.dev-core.development.use", "")) return;
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
      title: msg("program.development"),
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
          texts: Object.fromEntries(
            Object.entries(
              (await currentLocalization()?.bundle("the8020/dev-core"))
                ?.texts ?? {},
            ).filter(([key]) =>
              key.startsWith("frontend.") || key.startsWith("console.")
            ),
          ),
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
      status = localizedText(msg("program.refreshed"));
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
          status = localizedText(
            msg("program.development_sandbox_created_and_started"),
          );
        } else {
          await development.sandbox.run("start", developmentUserId);
          status = localizedText(msg("program.development_sandbox_started"));
        }
      }
      if (action === "stop" && sandbox !== undefined) {
        await development.sandbox.run("stop", developmentUserId);
        status = localizedText(msg("program.development_sandbox_stopped"));
      }
      if (action === "restart" && sandbox !== undefined) {
        await development.sandbox.run("restart", developmentUserId);
        status = localizedText(msg("program.development_sandbox_restarted"));
      }
      if (action === "reset-source" && sandbox !== undefined) {
        await development.sandbox.run(
          "reset-source",
          developmentUserId,
          { confirm: true },
        );
        status = localizedText(msg("program.development_source_reset"));
      }
      if (action === "factory-reset" && sandbox !== undefined) {
        await development.sandbox.run(
          "factory-reset",
          developmentUserId,
          { confirm: true },
        );
        status = localizedText(
          msg("program.development_sandbox_factory_reset"),
        );
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
      result.preview = await development.activate.preview({
        user_id: userId,
      }) as ActivationPreviewResult["preview"];
      pending = result.preview.pending;
      conflicted = pending?.status === "conflicted" &&
        !!pending.packages?.some((item) => item.conflict_worktree);
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
      ready: item.activation_ready
        ? localizedText(msg("program.ready"))
        : localizedText(msg("program.blocked")),
    }));
    const model: z.infer<typeof ActivationScreen> = {
      packages,
      message,
      status: previewError || (pending
        ? localizedText(
          msg("program.value1_value2_2", {
            value1: pending.status,
            value2: pending.error ??
              localizedText(msg("program.continue_or_abort_preserving_work")),
          }),
        )
        : "") ||
        (result.preview.retained?.length
          ? result.preview.retained.map((item) =>
            `${item.attempt_id}: ${item.status}. Recover/export at ${item.worktree}${
              item.status === "legacy-unresolved"
                ? `, or preserve with activate --abort --attempt ${item.attempt_id}`
                : ""
            }. ${item.recovery ?? ""}`
          ).join("\n")
          : "") ||
        (result.preview.inventory_truncated
          ? localizedText(
            msg(
              "program.retained_inventory_is_truncated_inspect_with_activate",
            ),
          )
          : "") ||
        status ||
        (!conflicted && packages.length === 0
          ? localizedText(msg("program.no_private_changes"))
          : localizedText(
            msg("program.review_the_changed_packages_and_enter_a"),
          )),
    };
    screenModel1 ??= new Model(model);
    screenModel1.data = model;
    const event = await callScreen({
      id: "development-activation",
      title: msg("program.activate_development_changes"),
      description: msg("program.activate_your_changes_for_all_ready_packages"),
      schema: ActivationScreen,
      model: screenModel1,
      layout: {
        ...activationLayout,
        root: {
          ...activationLayout.root,
          children: activationLayout.root.children.map((child) =>
            child.id === "changed-packages"
              ? {
                ...child,
                toolbar: [
                  ...(conflicted
                    ? [{
                      id: "resolve",
                      label: msg("program.resolve_conflicts"),
                      kind: "primary" as const,
                    }]
                    : []),
                  ...(pending
                    ? [{
                      id: "continue",
                      label: pending.status === "cleanup-pending"
                        ? localizedText(msg("program.retry_cleanup"))
                        : localizedText(msg("conflicts.continue_activation")),
                    }, {
                      id: "abort",
                      label: msg("program.abort_preserve_work"),
                    }]
                    : []),
                  ...(!pending && packages.length > 0
                    ? [{
                      id: "sync-all",
                      label: msg("program.activate_all_changes"),
                      kind: "primary" as const,
                    }]
                    : []),
                  ...(schemaPlan?.tables.some((t) =>
                      t.affected_columns.some((c) => c.repair !== "unsupported")
                    )
                    ? [{
                      id: "force",
                      label: msg("program.force_activation"),
                      kind: "danger" as const,
                    }]
                    : []),
                  { id: "refresh", label: msg("changes.refresh") },
                ],
              }
              : child
          ),
        },
      },
    });
    message = model.message;
    if (!previewError) status = model.status;
    if (event.action === BACK_EVENT) return;
    if (event.action === "change" || event.action === "refresh") {
      schemaPlan = undefined;
      continue;
    }
    if (event.action === "abort") {
      try {
        const result = await development.activate.run({
          user_id: userId,
          action: "abort",
        });
        if (!result.success) {
          throw new Error(
            String(
              result.error ??
                localizedText(msg("program.abort_could_not_finish")),
            ),
          );
        }
        status = result.status === "aborted-preserved"
          ? localizedText(
            msg("program.attempt_closed_files_and_captures_preserved_for"),
          )
          : localizedText(
            msg("program.attempt_closed_private_changes_remain_pending"),
          );
        sendMessage(status, "success");
      } catch (error) {
        status = error instanceof Error ? error.message : String(error);
        sendMessage(status, "error");
      }
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
      event.action === "force" || event.action === "continue"
    ) {
      if (message.trim() === "" && pending?.status !== "cleanup-pending") {
        status = "A commit message is required";
        sendMessage(status, "error");
        continue;
      }
      try {
        const selected = pending?.packages.map((p) => p.package_id) ??
          result.preview.packages.filter((p) => p.activation_ready).map((p) =>
            p.package_id
          );
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
            status = localizedText(
              msg("program.no_legal_automatic_column_repair_is_available"),
            );
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
        const pendingPackages = pending?.packages;
        if (
          event.action === "resolve" && pendingPackages &&
          !(await presentPage(() => resolveConflicts(userId, pendingPackages)))
        ) continue;
        let activation: ActivationRunResult["activation"];
        while (true) {
          activation = await development.activate.run({
            user_id: userId,
            action: pending ? "continue" : undefined,
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
          ) {
            pending = activation;
            continue;
          }
          break;
        }
        if (!activation.success) {
          throw new Error(
            activation.error ?? `Activation ${activation.status}`,
          );
        }
        message = "";
        schemaPlan = undefined;
        status = activation.phase === "aborted"
          ? localizedText(
            msg("program.attempt_closed_private_changes_remain_pending"),
          )
          : activation.resumed
          ? localizedText(
            msg(
              "program.captured_changes_activated_review_remaining_workspace_changes",
            ),
          )
          : localizedText(msg("program.all_package_changes_activated"));
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
        class: CONFIRM_CLASS,
        title: msg("program.force_activation_2"),
        description: msg(
          "program.commit_message_value2_cleanup_and_native_activation",
          {
            message: message,
            value2: tables.flatMap((t) =>
              t.affected_columns.filter((c) => c.repair !== "unsupported").map((
                c,
              ) =>
                localizedText(
                  msg(
                    c.repair === "null"
                      ? "program.incompatible_cells_to_null"
                      : "program.incompatible_cells_to_default",
                    {
                      table: t.table_id,
                      column: c.name,
                    },
                  ),
                )
              )
            ).join("\n"),
          },
        ),
        schema: z.object({
          confirmed: field(z.boolean(), {
            label: msg(
              "program.repair_incompatible_cells_in_the_listed_columns",
            ),
          }),
        }),
        model,
        header: {
          actions: [
            {
              id: "force",
              label: msg("program.force_activation_3"),
              kind: "danger",
            },
            { id: "cancel", label: msg("program.cancel") },
          ],
        },
      });
      if (event.action === BACK_EVENT || event.action === "cancel") {
        return false;
      }
      if (event.action === "force" && model.data.confirmed) return true;
      if (event.action === "force") {
        sendMessage(
          localizedText(
            msg("program.confirm_column_repair_before_force_activation"),
          ),
          "error",
        );
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
    return localizedText(msg("program.ready"));
  }
  if (sandbox === undefined) {
    await development.sandbox.run("create", userId);
    return localizedText(
      msg("program.development_sandbox_created_and_started"),
    );
  }
  await development.sandbox.run("start", userId);
  return localizedText(msg("program.development_sandbox_started"));
}

async function confirmReset(factory: boolean): Promise<boolean> {
  return await presentModal(async () => {
    const confirm = new Model({ confirmed: false });
    while (true) {
      const response = await callScreen({
        id: "development-reset-confirm",
        class: CONFIRM_CLASS,
        title: factory
          ? localizedText(msg("program.factory_reset_2"))
          : localizedText(msg("program.reset_source_2")),
        description: factory
          ? localizedText(
            msg("program.this_deletes_your_source_changes_root_home"),
          )
          : localizedText(
            msg("program.this_deletes_your_unactivated_source_changes_your"),
          ),
        schema: z.object({
          confirmed: developmentInfo.shape.confirmed,
        }),
        model: confirm,
        header: {
          actions: [{
            id: "reset",
            label: factory
              ? localizedText(msg("program.factory_reset"))
              : localizedText(msg("program.reset_source")),
            kind: "danger",
          }, { id: "cancel", label: msg("program.cancel") }],
        },
      });
      if (response.action === BACK_EVENT || response.action === "cancel") {
        return false;
      }
      if (response.action === "reset" && confirm.data.confirmed) return true;
      sendMessage(
        localizedText(
          msg("program.confirm_deletion_before_resetting_the_sandbox"),
        ),
        "error",
      );
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
      ? [{
        id: "start",
        label: msg("program.start_sandbox"),
        kind: "primary" as const,
      }]
      : [
        {
          id: "activate",
          label: msg("program.review_changes"),
          kind: "primary" as const,
        },
        {
          id: "stop",
          label: msg("program.stop_sandbox"),
          kind: "danger" as const,
        },
      ]),
    ...(running
      ? [{ id: "restart", label: msg("program.restart_sandbox") }]
      : []),
    ...(sandbox === undefined ? [] : [
      {
        id: "reset-source",
        label: msg("program.reset_source"),
        kind: "danger" as const,
      },
      {
        id: "factory-reset",
        label: msg("program.factory_reset"),
        kind: "danger" as const,
      },
    ]),
    { id: "refresh", label: msg("changes.refresh") },
  ];
}
