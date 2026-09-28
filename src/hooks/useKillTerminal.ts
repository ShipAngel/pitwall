"use client";

import { useCallback, useRef, useState } from "react";
import { terminalSessionKey } from "@/lib/terminal";
import type { KillTerminalResponse } from "@/types";
import { KILL_CLIENT_TIMEOUT_MS } from "@/lib/timeouts";

/**
 * Ending a per-PR tmux session.
 *
 * The sibling of `useFocusSession`, and the same split: markup in the component,
 * the request here, nothing in `src/lib` because that layer never touches the
 * network.
 *
 * Unlike focus, this destroys something — so it is two-step. The first click
 * arms the row, the second confirms. A modal would be heavier than the action
 * warrants, but a bare one-click kill next to a session you have Claude working
 * in is not something to put behind a hover target.
 */


/** What the confirming click asked for, beyond ending the session. */
export type KillOptions = {
  /** Also remove the worktree Pitwall created, if there is one. */
  removeWorktree?: boolean;
  /** Remove it even with uncommitted changes. Only from an explicit second choice. */
  force?: boolean;
};

export type KillTerminalState = {
  /** Key of the row awaiting confirmation, if any. */
  arming: string | null;
  /** Key of the row whose request is in flight. */
  pending: string | null;
  /** The last failure worth reporting, against the row that caused it. */
  problem: { key: string; detail: string } | null;
  /**
   * The last request that succeeded but declined part of what was asked —
   * a dirty worktree left in place. Not a failure: the session still ended.
   */
  notice: { key: string; detail: string } | null;
  /** First call arms the row; second call on the same row performs the kill. */
  requestKill: (
    repo: string,
    prNumber: number,
    options?: KillOptions,
  ) => Promise<void>;
  /** Abandon an armed row without killing it. */
  cancel: () => void;
};

export function useKillTerminal(
  /** Called with the session's key once it is genuinely gone. */
  onKilled?: (key: string) => void,
): KillTerminalState {
  const [arming, setArming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ key: string; detail: string } | null>(
    null,
  );
  const [notice, setNotice] = useState<{ key: string; detail: string } | null>(
    null,
  );
  // A ref for the same reason as useFocusSession: it must be true for the next
  // call in this tick, before a state update could have landed.
  const inFlight = useRef(false);

  const cancel = useCallback(() => setArming(null), []);

  const requestKill = useCallback(
    async (repo: string, prNumber: number, options?: KillOptions) => {
      const key = terminalSessionKey(repo, prNumber);

      // First click on this row only arms it. Arming a different row moves the
      // confirmation rather than leaving two rows armed at once.
      if (arming !== key) {
        setProblem(null);
        setNotice(null);
        setArming(key);
        return;
      }

      if (inFlight.current) return;
      inFlight.current = true;
      setProblem(null);
      setNotice(null);
      setArming(null);
      setPending(key);
      try {
        const res = await fetch("/api/terminal/kill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo,
            prNumber,
            ...(options?.removeWorktree ? { removeWorktree: true } : {}),
            ...(options?.force ? { force: true } : {}),
          }),
          signal: AbortSignal.timeout(KILL_CLIENT_TIMEOUT_MS),
        });
        const json = (await res.json()) as KillTerminalResponse;
        if (json.killed) {
          // Something was deliberately not done — a dirty worktree left alone.
          // Reported rather than swallowed: the row will come back as a
          // worktree-only one, and silence would make that look like a bug.
          if (json.blocked) setNotice({ key, detail: json.blocked });
          // The row should change, which needs the list refetched — tmux has
          // forgotten the session but SWR is still holding the old response.
          onKilled?.(key);
        } else {
          setProblem({ key, detail: json.detail });
        }
      } catch {
        setProblem({ key, detail: "Couldn't reach the dashboard's terminal endpoint." });
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [arming, onKilled],
  );

  return { arming, pending, problem, notice, requestKill, cancel };
}
