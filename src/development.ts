import { kernel } from "@the8020/kernel";
import { getSystemProfile } from "/p/the8020/system/profile.ts";
import { prepareTexts, text } from "/p/the8020/i18n/mod.ts";
import { msg } from "../i18n/messages.ts";

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
        const key = "development.activation_allowed";
        const setting = await kernel.settings.node.get(key);
        let refusal;
        switch (setting.active_value) {
          case "true":
            break;
          case "auto":
            if ((await getSystemProfile()).role === "development") break;
            refusal = msg("errors.activation_requires_development", {
              setting: key,
            });
            break;
          case "false":
            refusal = msg("errors.activation_disabled", { setting: key });
            break;
          default:
            refusal = msg("errors.invalid_activation_setting", {
              setting: key,
            });
        }
        if (refusal) {
          await prepareTexts(refusal);
          throw new Error(text(refusal));
        }
      }
      return await kernel.development.activate.run(...args);
    },
  },
};
