/**
 * term-server — the process that owns Pitwall's per-PR terminals.
 *
 * It exists as a sidecar rather than a Next route because Next has nowhere to
 * put a long-lived socket: route handlers are request-scoped and `next dev`
 * discards module state on every edit, so a pty held there would die constantly.
 *
 * It is deliberately thin. Every path, argument and session name is computed by
 * the pure functions in src/lib/terminal.ts, which are unit tested; this file is
 * wiring — sockets, processes and files.
 *
 * What the browser is allowed to say is limited to {repo, prNumber, branch}.
 * Nothing it sends is ever executed: the repo must appear in config.json, the
 * branch must survive isValidBranchName, and the command comes from config.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import * as nodePty from "node-pty";
import { readConfig } from "@/lib/config";
import { prepareWorktree, type WorktreeDeps } from "@/lib/worktreePrep";
import {
  CLOSE_PTY_EXIT,
  CLOSE_SESSION_ENDED,
  CLOSE_SESSION_FAILED,
  TERMINAL_PORT,
  TERMINAL_RUNTIME_FILE,
  createKeyedSerializer,
  isAllowedOrigin,
  resolveTerminalTarget,
  tmuxArgv,
  tmuxHasSessionArgv,
  type TerminalTarget,
} from "@/lib/terminal";

const APP_PORT = 3737;
const HOST = "127.0.0.1";
const RUNTIME_PATH = path.join(process.cwd(), TERMINAL_RUNTIME_FILE);

/** Minted per boot, so a stale token from a previous run is worthless. */
const TOKEN = randomBytes(32).toString("hex");

function log(msg: string) {
  process.stdout.write(`[term] ${msg}\n`);
}

/** Runs a command to completion, capturing output. Never goes through a shell. */
function run(
  file: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { code, stdout, stderr } = await run("git", ["-C", repoPath, ...args]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

/**
 * The real git, filesystem and log behind `prepareWorktree`, which lives in
 * src/lib/worktreePrep.ts so it can be tested with these faked.
 */
const WORKTREE_DEPS: WorktreeDeps = {
  git,
  async hasRef(repoPath, ref) {
    const { code } = await run("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", ref]);
    return code === 0;
  },
  realpath,
  log,
};

/**
 * Keyed on repo + branch, which is what `git worktree add` actually contends on
 * — not the worktree path, since two PRs sharing a head branch have different
 * paths but collide on the same checkout.
 */
const serializeWorktree = createKeyedSerializer<string>();

function ensureWorktree(
  target: TerminalTarget,
  notify: (msg: string) => void,
): Promise<string> {
  return serializeWorktree(`${target.repoPath}\u0000${target.branch}`, () =>
    prepareWorktree(target, notify, WORKTREE_DEPS),
  );
}

async function requireTmux(): Promise<void> {
  try {
    const { code } = await run("tmux", ["-V"]);
    if (code !== 0) throw new Error("tmux -V failed");
  } catch {
    throw new Error(
      "tmux is not installed. Terminals are backed by tmux so sessions survive restarts — install it with `brew install tmux`.",
    );
  }
}

/** Sends a status line to the browser's terminal, in dim text. */
function status(ws: WebSocket, msg: string) {
  ws.send(`\x1b[2m${msg}\x1b[0m\r\n`);
}

function fail(ws: WebSocket, msg: string) {
  ws.send(`\x1b[31m${msg}\x1b[0m\r\n`);
  ws.close(1011, CLOSE_SESSION_FAILED);
}

const wss = new WebSocketServer({
  host: HOST,
  port: TERMINAL_PORT,
  // The token proves the client got it from /api/terminal (same-origin, server
  // side). The Origin check is the separate half: WebSockets are exempt from
  // CORS, so without it any page you have open could reach this port.
  verifyClient: ({ origin, req }, done) => {
    if (!isAllowedOrigin(origin, APP_PORT)) {
      log(`rejected: bad origin ${origin ?? "(none)"}`);
      return done(false, 403, "Forbidden origin");
    }
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    if (url.searchParams.get("token") !== TOKEN) {
      log("rejected: bad token");
      return done(false, 401, "Bad token");
    }
    done(true);
  },
});

wss.on("connection", async (ws, req) => {
  // A ws socket is an EventEmitter, and an 'error' with no listener is an
  // uncaught exception in Node — which would take the sidecar and every other
  // attached terminal with it. ws 8 handles the paths reachable here internally,
  // so this is belt-and-braces, but it also puts transport failures in the log
  // instead of nowhere. The socket closes on its own; this only records why.
  ws.on("error", (err) => log(`socket error: ${err.message}`));

  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const repo = url.searchParams.get("repo") ?? "";
  const prNumber = Number(url.searchParams.get("pr"));
  const branch = url.searchParams.get("branch") ?? "";

  let target: TerminalTarget;
  try {
    target = resolveTerminalTarget({
      config: await readConfig(),
      request: { repo, prNumber, branch },
      home: homedir(),
    });
  } catch (err) {
    return fail(ws, err instanceof Error ? err.message : "Bad session request");
  }

  let cwd: string;
  try {
    await requireTmux();
    cwd = await ensureWorktree(target, (msg) => status(ws, msg));
  } catch (err) {
    return fail(ws, err instanceof Error ? err.message : "Could not prepare worktree");
  }

  // Preparing the worktree can take seconds (a `git fetch`), and the pane may
  // have been closed meanwhile. Its 'close' event has then already fired, before
  // the handler below existed, so a pty spawned now would never be killed: a
  // detached tmux client, and possibly a brand-new session, left running.
  if (ws.readyState !== ws.OPEN) {
    log(`closed during setup, not attaching ${target.sessionName}`);
    return;
  }

  const cols = Number(url.searchParams.get("cols")) || 80;
  const rows = Number(url.searchParams.get("rows")) || 24;

  log(`attach ${target.sessionName} → ${cwd}`);
  let pty: nodePty.IPty;
  try {
    pty = nodePty.spawn("tmux", tmuxArgv({ sessionName: target.sessionName, cwd, command: target.command }), {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
  } catch (err) {
    return fail(ws, `Could not start tmux: ${err instanceof Error ? err.message : err}`);
  }

  pty.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  // Which of the two happened is a question for tmux, not an assumption: the
  // pty exits both when you detach and when the session is killed out from under
  // you, and saying "still running" over a session that has just been ended is
  // worse than saying nothing.
  pty.onExit(({ exitCode }) => {
    if (ws.readyState !== ws.OPEN) return;
    void (async () => {
      // `run` rejects if tmux can't be spawned at all. Uncaught in a detached
      // async function that is an unhandled rejection, which would take the
      // whole sidecar down — and with it every other terminal. On failure we
      // simply don't know, so it falls back to the older, less final message
      // rather than claiming a session ended that may not have.
      let alive = true;
      try {
        const { code } = await run("tmux", tmuxHasSessionArgv(target.sessionName));
        alive = code === 0;
      } catch (err) {
        log(`has-session failed, assuming still running: ${err instanceof Error ? err.message : err}`);
      }
      if (ws.readyState !== ws.OPEN) return;
      if (alive) {
        status(ws, `tmux client exited (${exitCode}). The session is still running.`);
        ws.close(1000, CLOSE_PTY_EXIT);
      } else {
        status(ws, `Session ended (${exitCode}).`);
        ws.close(1000, CLOSE_SESSION_ENDED);
      }
    })();
  });

  // Binary frames are keystrokes; text frames are control messages. Splitting
  // them by frame type means input never has to be escaped or parsed.
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      pty.write(data.toString());
      return;
    }
    try {
      const msg: unknown = JSON.parse(data.toString());
      if (
        msg &&
        typeof msg === "object" &&
        (msg as { type?: string }).type === "resize"
      ) {
        const { cols: c, rows: r } = msg as { cols?: number; rows?: number };
        if (Number.isInteger(c) && Number.isInteger(r) && c! > 0 && r! > 0) {
          pty.resize(c!, r!);
        }
      }
    } catch {
      // Not JSON — ignore rather than treat it as input, which would inject
      // stray characters into a live Claude Code session.
    }
  });

  // Killing the pty detaches the tmux client. The tmux session, and everything
  // running in it, stays alive — that is the whole point of the design.
  ws.on("close", () => {
    log(`detach ${target.sessionName}`);
    try {
      pty.kill();
    } catch {
      // Already gone.
    }
  });
});

wss.on("listening", async () => {
  // 0600: the token in here is enough to open a shell on this machine.
  await writeFile(
    RUNTIME_PATH,
    JSON.stringify({ port: TERMINAL_PORT, token: TOKEN }),
    { mode: 0o600 },
  );
  // writeFile's `mode` applies only when it creates the file, and a crash leaves
  // the old one behind (only shutdown() unlinks it) — so a restart would write a
  // fresh token into a file that kept whatever permissions it already had.
  await chmod(RUNTIME_PATH, 0o600);
  log(`listening on ws://${HOST}:${TERMINAL_PORT}`);
  try {
    await requireTmux();
  } catch (err) {
    log(`WARNING: ${err instanceof Error ? err.message : err}`);
  }
});

wss.on("error", (err) => {
  log(`server error: ${err.message}`);
  process.exit(1);
});

async function shutdown() {
  log("shutting down (tmux sessions keep running)");
  try {
    await unlink(RUNTIME_PATH);
  } catch {
    // Never written, or already gone.
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
