import { development } from "./development.ts";
import { AdminCommandError } from "@the8020/kernel";
import {
  parseCommandArguments,
  requiredCommandArgument,
} from "/p/the8020/packages/commands.ts";

export function imageStatus() {
  return development.imageStatus().then((image) => ({ image }));
}

export function sandboxList() {
  return development.sandbox.list().then((sandboxes) => ({ sandboxes }));
}

export function sandboxAction(action: string, args: string[]) {
  const booleanOptions = action === "factory-reset" || action === "reset-source"
    ? ["confirm"]
    : [];
  const valueOptions = action === "shell" ? ["command"] : [];
  const parsed = parseCommandArguments(args, {
    booleans: booleanOptions,
    values: valueOptions,
  });
  if (booleanOptions.length > 0 && parsed.options.confirm !== true) {
    throw new AdminCommandError({
      code: "invalid_arguments",
      message: "--confirm is required",
    });
  }
  const input: Record<string, unknown> = {};
  if (parsed.options.confirm !== undefined) {
    input.confirm = parsed.options.confirm;
  }
  if (parsed.options.command !== undefined) {
    input.command = parsed.options.command;
  }
  return development.sandbox.run(
    action,
    requiredCommandArgument(parsed.positionals, 0, "user ID"),
    input,
  );
}

function activationInput(args: string[], requireMessage: boolean) {
  const parsed = parseCommandArguments(args, {
    values: [
      ...(!requireMessage ? ["file"] : []),
      "message",
      "packages",
      "package-messages",
      "author-name",
      "author-email",
      "metadata",
    ],
  });
  if (requireMessage && typeof parsed.options.message !== "string") {
    throw new AdminCommandError({
      code: "invalid_arguments",
      message: "--message is required",
    });
  }
  return {
    user_id: requiredCommandArgument(parsed.positionals, 0, "user ID"),
    ...(!requireMessage ? { file: parsed.options.file } : {}),
    message: parsed.options.message,
    packages: parsed.options.packages,
    package_messages: parsed.options["package-messages"],
    author_name: parsed.options["author-name"],
    author_email: parsed.options["author-email"],
    metadata: parsed.options.metadata,
  };
}

export function activationPreview(...args: string[]) {
  return development.activate.preview(activationInput(args, false))
    .then((preview) => ({ preview }));
}

export function activationRun(...args: string[]) {
  return development.activate.run(activationInput(args, true))
    .then((activation) => ({ activation }));
}
