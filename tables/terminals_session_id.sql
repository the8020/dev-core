-- Run once on an existing terminal table before deploying the new descriptor.
-- SQLite and PostgreSQL; fresh databases do not need this migration.
BEGIN;
ALTER TABLE "the8020__dev_core__terminals"
  ADD COLUMN "sessionId" TEXT NOT NULL DEFAULT '';
UPDATE "the8020__dev_core__terminals" SET "sessionId" = "terminalId";
COMMIT;
