import { kernel } from "@the8020/kernel";
import { getSystemProfile } from "/p/the8020/system/profile.ts";

/** Shared application policy for development commands and interactive screens. */
export const development = {
  ...kernel.development,
  sandbox: {
    ...kernel.development.sandbox,
  },
  activate: {
    ...kernel.development.activate,
    async run(...args: Parameters<typeof kernel.development.activate.run>) {
      if (args[0].action !== "status" && args[0].action !== "abort") {
        const setting = await kernel.settings.node.get(
          "development.activation_allowed",
        );
        switch (setting.active_value) {
          case "true":
            break;
          case "auto":
            if ((await getSystemProfile()).role === "development") break;
            throw new Error(
              "Sandbox activation requires a development system or development.activation_allowed=true.",
            );
          case "false":
            throw new Error(
              "Sandbox activation is disabled by development.activation_allowed=false.",
            );
          default:
            throw new Error("Invalid development.activation_allowed setting.");
        }
      }
      return await kernel.development.activate.run(...args);
    },
  },
};
