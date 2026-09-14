import { kernel } from "@the8020/kernel";
import { requireDevelopment } from "/p/the8020/system/profile.ts";

/** Shared application policy for development commands and interactive screens. */
export const development = {
  ...kernel.development,
  sandbox: {
    ...kernel.development.sandbox,
    async run(...args: Parameters<typeof kernel.development.sandbox.run>) {
      if (!["inspect", "stop", "kill", "delete"].includes(args[0])) {
        await requireDevelopment();
      }
      return await kernel.development.sandbox.run(...args);
    },
  },
  activate: {
    ...kernel.development.activate,
    async run(...args: Parameters<typeof kernel.development.activate.run>) {
      await requireDevelopment();
      return await kernel.development.activate.run(...args);
    },
  },
};
