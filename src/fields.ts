import { field, z } from "/p/the8020/db/fields.ts";

export const developmentInfo = z.object({
  sandboxId: field(z.string(), {
    label: "Sandbox ID",
    description:
      "Your development sandbox. Use the terminal above to work in it, or the sandbox actions to restart or reset it.",
  }),
  state: field(z.string(), {
    label: "State",
    description:
      "The current state of your development sandbox. Ready and conflicted sandboxes can be used in the terminal.",
  }),
  status: field(z.string(), {
    label: "Last operation",
    description: "The result of the most recent development sandbox action.",
  }),
  changedFiles: field(z.number().int().nonnegative(), {
    label: "Changed files",
    description:
      "Files added, changed, or removed in this package since its current active version.",
  }),
  addedRows: field(z.number().int().nonnegative(), {
    label: "Added rows",
    description: "Text lines added by the package changes in this preview.",
  }),
  removedRows: field(z.number().int().nonnegative(), {
    label: "Removed rows",
    description: "Text lines removed by the package changes in this preview.",
  }),
  ready: field(z.string(), {
    label: "Activation readiness",
    description:
      "Ready packages can be activated. Resolve blocked package changes before activating.",
  }),
  message: field(z.string(), {
    label: "Commit message",
    description:
      "Required. The same message is used for every changed package in this activation.",
  }),
  activationStatus: field(z.string(), {
    label: "Activation status",
    description:
      "The result of reviewing or activating the current package changes.",
  }),
  confirmed: field(z.boolean(), {
    label: "I understand that these changes will be deleted",
    description:
      "Confirm only after reviewing which changes this reset deletes. Cancel to keep them.",
  }),
});
