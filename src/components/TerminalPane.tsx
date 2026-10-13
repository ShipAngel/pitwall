"use client";

import { useTerminalSocket } from "@/hooks/useTerminalSocket";
import type { OpenTerminal, TerminalHandshake } from "@/types";
import "@xterm/xterm/css/xterm.css";

/**
 * One PR's terminal.
 *
 * Markup and the status line only — the xterm and socket lifecycle live in
 * `useTerminalSocket`. Panes are never unmounted while open; the dock hides the
 * inactive ones, so switching PRs is instant and background sessions keep
 * streaming.
 */
export default function TerminalPane({
  terminal,
  handshake,
  active,
}: {
  terminal: OpenTerminal;
  handshake: TerminalHandshake;
  active: boolean;
}) {
  const { hostRef, status, reconnect } = useTerminalSocket({
    terminal,
    handshake,
    active,
  });

  return (
    <div className={`absolute inset-0 flex flex-col ${active ? "" : "invisible"}`}>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 pt-1" />
      {status !== "open" && (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-bg-panel px-3 py-1.5 text-xs">
          <span
            className={
              status === "error" || status === "failed"
                ? "text-accent-red"
                : "text-text-muted"
            }
          >
            {status === "connecting" && "Connecting…"}
            {status === "detached" &&
              "Detached. The tmux session is still running — reconnect to reattach."}
            {/* Not "detached": this session is gone, so there is nothing to
                reattach to. Reconnecting would start a fresh one, because
                tmuxArgv uses `new-session -A` — so the button says that. */}
            {status === "ended" &&
              "This session has ended. Starting again gives you a new one, in the same worktree."}
            {status === "failed" && "The session could not be started."}
            {status === "error" && "Could not reach the terminal server."}
          </span>
          {status !== "connecting" && (
            <button
              type="button"
              onClick={reconnect}
              className="rounded-sm border border-line px-2 py-0.5 text-text-primary transition hover:bg-bg-row"
            >
              {status === "ended" ? "Start again" : "Reconnect"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
