import { db } from "/p/the8020/db/mod.ts";
import Terminals, { type TerminalRecord } from "../tables/terminals.ts";
export type { TerminalRecord } from "../tables/terminals.ts";

export interface TerminalMetadataStore {
  list(
    userId: string,
    kind: TerminalRecord["targetKind"],
    sandboxId: string,
  ): Promise<TerminalRecord[]>;
  get(userId: string, terminalId: string): Promise<TerminalRecord | undefined>;
  find(
    userId: string,
    kind: TerminalRecord["targetKind"],
    sandboxId: string,
    sessionId: string,
  ): Promise<TerminalRecord | undefined>;
  create(record: TerminalRecord): Promise<void>;
  rename(userId: string, terminalId: string, name: string): Promise<void>;
  remove(userId: string, terminalId: string): Promise<void>;
}

export const terminalMetadataStore: TerminalMetadataStore = {
  list(userId, kind, sandboxId) {
    return db.selectFrom(Terminals.table).selectAll()
      .where("authenticatedUserId", "=", userId)
      .where("targetKind", "=", kind).where("targetSandboxId", "=", sandboxId)
      .orderBy("createdAt").limit(257).execute();
  },
  get(userId, terminalId) {
    return db.selectFrom(Terminals.table).selectAll()
      .where("authenticatedUserId", "=", userId)
      .where("terminalId", "=", terminalId).executeTakeFirst();
  },
  find(userId, kind, sandboxId, sessionId) {
    return db.selectFrom(Terminals.table).selectAll()
      .where("authenticatedUserId", "=", userId)
      .where("targetKind", "=", kind).where("targetSandboxId", "=", sandboxId)
      .where("sessionId", "=", sessionId).executeTakeFirst();
  },
  async create(record) {
    await db.insertInto(Terminals.table).values(record).onConflict((conflict) =>
      conflict.columns(["targetKind", "targetSandboxId", "sessionId"])
        .doUpdateSet(record)
    ).execute();
  },
  async rename(userId, terminalId, name) {
    await db.updateTable(Terminals.table).set({ name })
      .where("authenticatedUserId", "=", userId).where(
        "terminalId",
        "=",
        terminalId,
      ).execute();
  },
  async remove(userId, terminalId) {
    await db.deleteFrom(Terminals.table).where(
      "authenticatedUserId",
      "=",
      userId,
    )
      .where("terminalId", "=", terminalId).execute();
  },
};
