/**
 * TaleShed version info for MCP `version` tool.
 * Uses git HEAD committer date as a proxy for “last push” when the server runs from a clone.
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

export interface TaleshedVersionInfo {
  /** From package.json (semver). */
  package_version: string;
  /** ISO 8601 committer date of HEAD, or null if git unavailable. */
  last_commit_at: string | null;
  /** Short git SHA of HEAD, or null. */
  short_commit: string | null;
  /** One line for assistants to read aloud. */
  summary: string;
}

export function getTaleshedVersionInfo(): TaleshedVersionInfo {
  let package_version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.trim()) package_version = pkg.version.trim();
  } catch {
    /* ignore */
  }

  let last_commit_at: string | null = null;
  let short_commit: string | null = null;
  try {
    last_commit_at =
      execSync("git log -1 --format=%cI", { cwd: PROJECT_ROOT, encoding: "utf8" }).trim() || null;
    short_commit =
      execSync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT, encoding: "utf8" }).trim() || null;
  } catch {
    /* not a git checkout or git not on PATH */
  }

  const summary =
    last_commit_at != null
      ? `TaleShed ${package_version}; last commit ${last_commit_at}${short_commit ? ` (${short_commit})` : ""}.`
      : `TaleShed ${package_version}. (Git commit date unavailable—use package version only, or ensure the server runs from a git clone with git on PATH.)`;

  return { package_version, last_commit_at, short_commit, summary };
}
