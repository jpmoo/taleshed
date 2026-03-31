/**
 * Load `.env` from the TaleShed project root (parent of `dist/`), not from `process.cwd()`.
 * `import "dotenv/config"` only looks at cwd; systemd and other supervisors often use a cwd
 * that is not the repo (or `/`), so `.env` would be skipped and TALESHED_DEBUG / OLLAMA_* would not apply.
 * Does not override variables already set (e.g. systemd `EnvironmentFile=`).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });
