import { msg } from "/p/the8020/dev-core/i18n/messages.ts";
import { choiceHelp, field, z } from "/p/the8020/db/fields.ts";

export const activationChange = field(z.string(), {
  label: msg("fields.change"),
  description: msg("fields.added_modified_or_deleted_moves_appear_as"),
  valueHelp: choiceHelp(z.string(), [
    { value: "[[icon=add color=success]] Added", label: msg("fields.added") },
    { value: "[[icon=edit]] Modified", label: msg("fields.modified") },
    {
      value: "[[icon=remove color=error]] Deleted",
      label: msg("fields.deleted"),
    },
  ]),
});

export const developmentInfo = z.object({
  sandboxId: field(z.string(), {
    label: msg("fields.sandbox_id"),
    description: msg("fields.your_development_sandbox_use_the_terminal_above"),
  }),
  state: field(z.string(), {
    label: msg("fields.state"),
    description: msg("fields.the_current_state_of_your_development_sandbox"),
    valueHelp: choiceHelp(z.string(), [
      "ABSENT",
      "CREATING",
      "STARTING",
      "READY",
      "BUSY",
      "ACTIVATING",
      "CONFLICTED",
      "STOPPING",
      "STOPPED",
      "FAILED",
      "RESETTING",
      "DELETING",
    ]),
  }),
  status: field(z.string(), {
    label: msg("fields.last_operation"),
    description: msg("fields.the_result_of_the_most_recent_development"),
  }),
  changedFiles: field(z.number().int().nonnegative(), {
    label: msg("changes.changed_files"),
    description: msg("fields.files_added_changed_or_removed_in_this"),
  }),
  addedRows: field(z.number().int().nonnegative(), {
    label: msg("fields.added_rows"),
    description: msg("fields.text_lines_added_by_the_package_changes"),
  }),
  removedRows: field(z.number().int().nonnegative(), {
    label: msg("fields.removed_rows"),
    description: msg("fields.text_lines_removed_by_the_package_changes"),
  }),
  ready: field(z.string(), {
    label: msg("fields.activation_readiness"),
    description: msg("fields.ready_packages_can_be_activated_resolve_blocked"),
    valueHelp: choiceHelp(z.string(), [
      msg("program.ready"),
      msg("program.blocked"),
    ]),
  }),
  message: field(z.string(), {
    label: msg("fields.commit_message"),
    description: msg("fields.required_the_same_message_is_used_for"),
  }),
  activationStatus: field(z.string(), {
    label: msg("fields.activation_status"),
    description: msg("fields.the_result_of_reviewing_or_activating_the"),
  }),
  confirmed: field(z.boolean(), {
    label: msg("fields.i_understand_that_these_changes_will_be"),
    description: msg("fields.confirm_only_after_reviewing_which_changes_this"),
  }),
});

export const conflictInfo = z.object({
  path: field(z.string(), {
    label: msg("program.file"),
    description: msg("fields.the_conflicting_file_within_this_package"),
  }),
  kind: field(z.string(), {
    label: msg("fields.conflict"),
    description: msg("fields.which_versions_changed_or_deleted_this_file"),
    valueHelp: choiceHelp(z.string(), [
      msg("choices.both_changed"),
      msg("choices.deleted_upstream"),
      msg("choices.deleted_by_you"),
      msg("choices.added_upstream"),
    ]),
  }),
  content: field(z.string(), {
    label: msg("fields.file_contents"),
    description: msg("fields.resolve_the_git_marked_sections_remove_the"),
  }),
  status: field(z.string(), {
    label: msg("fields.resolution_status"),
    description: msg("fields.resolve_every_file_before_continuing_activation"),
  }),
});

export const activationFileInfo = z.object({
  path: field(z.string(), {
    label: msg("program.file"),
    description: msg("fields.changed_filename_within_this_package_open_it"),
  }),
  change: activationChange,
  diff: field(z.string(), {
    label: msg("fields.changes"),
  }),
});
