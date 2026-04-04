#!/usr/bin/env node
/**
 * Migration: add base_power, attack_power, defense_power to world_graph.
 *
 * Safe to run multiple times — uses ALTER TABLE only if the column is missing.
 * Run from the project root:
 *   node scripts/add-combat-columns.js
 * Or with a custom DB path:
 *   TALESHED_DB_PATH=/path/to/taleshed.db node scripts/add-combat-columns.js
 */

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDbPath = path.join(__dirname, "..", "taleshed.db");
const dbPath = process.env.TALESHED_DB_PATH ?? defaultDbPath;

if (!fs.existsSync(dbPath)) {
  console.error("Database not found at:", dbPath);
  console.error("Set TALESHED_DB_PATH or run from the project root.");
  process.exit(1);
}

const db = new Database(dbPath);

const columns = [
  { name: "base_power",    type: "REAL" },
  { name: "attack_power",  type: "REAL" },
  { name: "defense_power", type: "REAL" },
];

for (const col of columns) {
  const exists = db
    .prepare("SELECT 1 FROM pragma_table_info('world_graph') WHERE name = ?")
    .get(col.name);
  if (exists) {
    console.log(`  already exists: ${col.name} — skipped`);
  } else {
    db.exec(`ALTER TABLE world_graph ADD COLUMN ${col.name} ${col.type}`);
    console.log(`  added: ${col.name} ${col.type}`);
  }
}

db.close();
console.log("Done.");
