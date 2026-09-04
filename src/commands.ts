import {
  AdminCommandError,
  kernel,
  parseCommandArguments,
  requiredCommandArgument,
} from "@the8020/kernel";

export function imageStatus() {
  return kernel.development.imageStatus().then((image) => ({ image }));
}

export function sandboxList() {
  return kernel.development.sandbox.list().then((sandboxes) => ({ sandboxes }));
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
  return kernel.development.sandbox.run(
    action,
    requiredCommandArgument(parsed.positionals, 0, "user ID"),
    input,
  );
}

function activationInput(args: string[], requireMessage: boolean) {
  const parsed = parseCommandArguments(args, {
    values: [
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
    message: parsed.options.message,
    packages: parsed.options.packages,
    package_messages: parsed.options["package-messages"],
    author_name: parsed.options["author-name"],
    author_email: parsed.options["author-email"],
    metadata: parsed.options.metadata,
  };
}

export function activationPreview(...args: string[]) {
  return kernel.development.activate.preview(activationInput(args, false))
    .then((preview) => ({ preview }));
}

export function activationRun(...args: string[]) {
  return kernel.development.activate.run(activationInput(args, true))
    .then((activation) => ({ activation }));
}
