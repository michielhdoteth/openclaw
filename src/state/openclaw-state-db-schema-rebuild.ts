import type { DatabaseSync } from "node:sqlite";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export function rebuildCanonicalStateTable(
  db: DatabaseSync,
  tableName: string,
  version: number,
): void {
  const migrationTable = `${tableName}_migration_v${version}`;
  if (tableExists(db, migrationTable)) {
    throw new Error(`OpenClaw v${version} migration table already exists: ${migrationTable}`);
  }
  const startMarker = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(startMarker);
  const endMarker = "\n) STRICT;";
  const end = start >= 0 ? OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) {
    throw new Error(`Canonical ${tableName} schema block is missing`);
  }
  const migrationSchema = OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + endMarker.length).replace(
    startMarker,
    `CREATE TABLE ${migrationTable} (`,
  );
  db.exec(migrationSchema);
  const columns = db
    .prepare(`PRAGMA table_xinfo(${migrationTable})`)
    .all()
    .flatMap((column) =>
      column.hidden === 0 && typeof column.name === "string"
        ? [quoteSqliteIdentifier(column.name)]
        : [],
    )
    .join(", ");
  db.exec(`INSERT INTO ${migrationTable} (${columns}) SELECT ${columns} FROM ${tableName};`);
  db.exec(`DROP TABLE ${tableName};`);
  db.exec(`ALTER TABLE ${migrationTable} RENAME TO ${tableName};`);
}
