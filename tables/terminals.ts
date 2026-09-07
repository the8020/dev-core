import {
  type Row,
  type Selectable,
  t,
  table,
  type TableDatabase,
} from "/p/the8020/db/mod.ts";

const Terminals = table("the8020__dev_core__terminals", {
  terminalId: t.text().primaryKey(),
  name: t.text(),
  authenticatedUserId: t.text(),
  targetKind: t.enum(["development", "runtime"] as const),
  targetSandboxId: t.text(),
  nodeId: t.text(),
  ownerSandboxId: t.text(),
  workerId: t.text(),
  persistentExecutionId: t.text(),
  createdAt: t.datetime(),
}, {
  indexes: [{
    columns: ["authenticatedUserId", "targetKind", "targetSandboxId"],
  }],
});

declare module "/p/the8020/db/types.ts" {
  interface Database extends TableDatabase<typeof Terminals> {}
}

export type TerminalRecord = Selectable<Row<typeof Terminals>>;
export default Terminals;
