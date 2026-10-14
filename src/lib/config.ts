import { readFile } from "node:fs/promises";
import path from "node:path";
import { repoAlias } from "./github";
import { sanitizeForTmux } from "./terminal";
import type { AppConfig, RepoConfig } from "@/types";

/**
 * GitHub's own character sets: owners are letters, digits and hyphens; repo
 * names add `.` and `_`. Checked because both are written straight into GraphQL
 * query text, where a quote would break the query - and one broken query takes
 * the whole GitHub panel down.
 */
const GITHUB_OWNER = /^[A-Za-z0-9-]+$/;
const GITHUB_REPO_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Used when config.json has no `refreshIntervalSeconds`. Five minutes keeps well
 * inside Linear's hourly rate limit.
 */
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;

/**
 * Refuses two repos whose GraphQL aliases would collide.
 *
 * `repoAlias` turns every non-alphanumeric into `_`, so `a-b/c` and `a/b-c` (or
 * `x/my.app` and `x/my-app`) share an alias. GraphQL rejects the duplicate, and
 * the GitHub and Security panels both go down.
 *
 * It also refuses two repos that would share a tmux session name, which would
 * mean opening or ending one repo's PR could hit the other's session, with a
 * live Claude in it.
 */
function rejectCollidingAliases(repos: RepoConfig[]): void {
  // Two derivations, checked separately: `repoAlias` maps each disallowed
  // character to `_`, while `sanitizeForTmux` maps a whole run of them to one
  // `-`, so `x/my..app` and `x/my.app` differ as aliases but share a session.
  const derivations: Array<[string, (r: RepoConfig) => string]> = [
    // GitHub treats owner and name case-insensitively, so these are one repo
    // listed twice - and terminals, which match case-insensitively, would only
    // ever reach the first.
    ["GitHub, which ignores case,", (r) => `${r.owner}/${r.name}`.toLowerCase()],
    ["GitHub's query", (r) => repoAlias(r.owner, r.name)],
    ["per-PR terminals", (r) => sanitizeForTmux(`${r.owner}/${r.name}`)],
  ];
  for (const [what, derive] of derivations) {
    const seen = new Map<string, string>();
    for (const r of repos) {
      const slug = `${r.owner}/${r.name}`;
      const key = derive(r);
      const first = seen.get(key);
      if (first !== undefined && first !== slug) {
        throw new Error(
          `config.json: '${first}' and '${slug}' can't both be tracked: ${what} ` +
            `would give them the same name. Remove one.`,
        );
      }
      seen.set(key, slug);
    }
  }
}

export function validateConfig(parsed: unknown): AppConfig {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("config.json: must be a JSON object");
  }
  const c = parsed as Partial<AppConfig>;

  if (!Array.isArray(c.repos)) {
    throw new Error("config.json: 'repos' must be an array");
  }
  for (const [i, r] of c.repos.entries()) {
    if (
      !r ||
      typeof r !== "object" ||
      typeof r.owner !== "string" ||
      typeof r.name !== "string" ||
      !r.owner ||
      !r.name
    ) {
      throw new Error(
        `config.json: repos[${i}] must have 'owner' and 'name' strings`,
      );
    }
    if (!GITHUB_OWNER.test(r.owner) || !GITHUB_REPO_NAME.test(r.name)) {
      throw new Error(
        `config.json: repos[${i}] '${r.owner}/${r.name}' isn't a valid GitHub owner/name`,
      );
    }
    if (
      r.localPath !== undefined &&
      (typeof r.localPath !== "string" || r.localPath.trim() === "")
    ) {
      throw new Error(
        `config.json: repos[${i}].localPath, if set, must be a non-empty string`,
      );
    }
  }

  rejectCollidingAliases(c.repos);

  if (!c.linear || typeof c.linear !== "object") {
    throw new Error("config.json: 'linear' object is required");
  }
  if (!c.linear.teamKey || typeof c.linear.teamKey !== "string") {
    throw new Error("config.json: 'linear.teamKey' must be a non-empty string");
  }
  if (
    c.linear.inProgressStatusName !== undefined &&
    (typeof c.linear.inProgressStatusName !== "string" ||
      c.linear.inProgressStatusName.trim() === "")
  ) {
    throw new Error(
      "config.json: 'linear.inProgressStatusName', if set, must be a non-empty string",
    );
  }

  if (
    c.refreshIntervalSeconds !== undefined &&
    (typeof c.refreshIntervalSeconds !== "number" ||
      !Number.isFinite(c.refreshIntervalSeconds) ||
      c.refreshIntervalSeconds <= 0)
  ) {
    throw new Error(
      "config.json: 'refreshIntervalSeconds', if set, must be a positive number",
    );
  }

  if (
    c.wipLabel !== undefined &&
    (typeof c.wipLabel !== "string" || c.wipLabel.trim() === "")
  ) {
    throw new Error(
      "config.json: 'wipLabel', if set, must be a non-empty string",
    );
  }

  if (
    c.hotspotThreshold !== undefined &&
    (typeof c.hotspotThreshold !== "number" ||
      !Number.isInteger(c.hotspotThreshold) ||
      c.hotspotThreshold < 1)
  ) {
    throw new Error("config.json: 'hotspotThreshold', if set, must be a whole number of at least 1");
  }

  if (c.terminals !== undefined) {
    const t = c.terminals;
    if (!t || typeof t !== "object") {
      throw new Error("config.json: 'terminals', if set, must be an object");
    }
    if (typeof t.enabled !== "boolean") {
      throw new Error("config.json: 'terminals.enabled' must be a boolean");
    }
    if (
      t.worktreeRoot !== undefined &&
      (typeof t.worktreeRoot !== "string" || t.worktreeRoot.trim() === "")
    ) {
      throw new Error(
        "config.json: 'terminals.worktreeRoot', if set, must be a non-empty string",
      );
    }
    // An empty command array would spawn nothing, so it is rejected rather than
    // silently falling back to the default.
    if (t.command !== undefined) {
      if (
        !Array.isArray(t.command) ||
        t.command.length === 0 ||
        t.command.some((a) => typeof a !== "string" || a === "")
      ) {
        throw new Error(
          "config.json: 'terminals.command', if set, must be a non-empty array of non-empty strings",
        );
      }
    }

  }

  // Defaulted here rather than at each reader, so AppConfig keeps it a number
  // and nothing downstream can multiply an undefined into NaN.
  return {
    ...c,
    refreshIntervalSeconds:
      c.refreshIntervalSeconds === undefined
        ? DEFAULT_REFRESH_INTERVAL_SECONDS
        : c.refreshIntervalSeconds,
  } as AppConfig;
}

export async function readConfig(): Promise<AppConfig> {
  const filePath = path.join(process.cwd(), "config.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "config.json not found. Copy config.example.json to config.json and edit it.",
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `config.json isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateConfig(parsed);
}
