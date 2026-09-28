import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseTerminalRuntime, type TerminalRuntime } from "./terminal";

/** Thrown when the sidecar isn't running, so the route can answer 503. */
export class TerminalServerNotRunning extends Error {
  constructor() {
    super(
      "Terminal server is not running. Start it with `npm run term` (./start.sh runs both).",
    );
    this.name = "TerminalServerNotRunning";
  }
}

/**
 * Reads the port and token the sidecar wrote at boot.
 *
 * Split from lib/terminal.ts so that file stays free of I/O, and out of the
 * route so the filesystem access isn't in a bundled module graph.
 */
export async function readTerminalRuntime(): Promise<TerminalRuntime> {
  // The filename is a literal, not the imported TERMINAL_RUNTIME_FILE, because
  // Turbopack can only fold a path it can see: given a constant from another
  // module it assumes the whole project is being read and warns on every build.
  // A test pins this string to that constant so the two can't drift.
  const filePath = path.join(process.cwd(), ".pitwall-terminal.json");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TerminalServerNotRunning();
    }
    throw err;
  }
  return parseTerminalRuntime(raw);
}
