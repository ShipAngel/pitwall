import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { COMMAND_TIMEOUT_MS } from "./timeouts";

/**
 * The only place this app runs a subprocess.
 *
 * It exists as its own module so the routes stay mockable: a route test replaces
 * `@/lib/exec` the same way the GitHub route tests replace `readConfig`, rather
 * than trying to stand in for `node:child_process` — where `execFile` carries a
 * custom promisify hook, and a hand-rolled double that misses it resolves to a
 * bare string instead of `{ stdout }`, passing tests while production breaks.
 *
 * `execFile` and not `exec`: arguments are passed as an array, so no shell parses
 * them and nothing needs escaping.
 */
const run = promisify(execFile);

/**
 * Output is capped well above the largest thing we ask for — a full `lsof` dump
 * is a few hundred kilobytes — so a runaway command can't exhaust memory.
 */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export const DEFAULT_TIMEOUT_MS = COMMAND_TIMEOUT_MS;

/** Runs a command and returns its stdout. Throws if it fails or times out. */
export async function runCommand(
  cmd: string,
  args: readonly string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  // No encoding option is passed, so execFile resolves stdout as a string.
  const { stdout } = await run(cmd, [...args], {
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return stdout;
}

/**
 * Runs a command for whatever it manages to produce, treating failure as "no
 * information".
 *
 * Every source behind the sessions panel is optional: `lsof` can be denied,
 * iTerm2 can be absent, and `osascript` exits non-zero when macOS hasn't granted
 * Automation access. None of that should blank the panel — a row just loses the
 * detail that source would have contributed.
 */
export async function tryCommand(
  cmd: string,
  args: readonly string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  try {
    return await runCommand(cmd, args, timeoutMs);
  } catch {
    return "";
  }
}
