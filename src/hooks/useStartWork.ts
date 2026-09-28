"use client";

import { useCallback, useRef, useState } from "react";
import type { StartWorkResponse } from "@/types";

/**
 * Starting work on a ticket: the request, and the one-at-a-time guard around it.
 *
 * The sibling of `useKillTerminal`, and the same split — markup in the
 * component, the fetch here, the rules in `src/lib/startWork.ts`.
 *
 * No two-step confirmation, unlike killing a session. This creates rather than
 * destroys, it refuses outright on someone else's ticket, and running it twice
 * on your own returns the PR it made the first time. The double-submit guard is
 * about a slow round trip, not about danger.
 */

/** Generous: this is up to four upstream round trips, two of them writes. */
const START_WORK_TIMEOUT_MS = 30_000;

export type StartWorkState = {
  pending: boolean;
  /** The last outcome, successful or not. Cleared when a new attempt starts. */
  result: StartWorkResponse | null;
  start: (ticketId: string, repo: string) => Promise<void>;
  reset: () => void;
};

export function useStartWork(
  /** Called after a successful run so the dashboard can refetch and show the PR. */
  onStarted?: () => void,
): StartWorkState {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<StartWorkResponse | null>(null);
  // A ref, not `pending`: it has to be true for the next call in this tick,
  // before a state update could have landed. Same reason as useKillTerminal.
  const inFlight = useRef(false);

  const reset = useCallback(() => setResult(null), []);

  const start = useCallback(
    async (ticketId: string, repo: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setResult(null);
      setPending(true);
      try {
        const res = await fetch("/api/start-work", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketId, repo }),
          signal: AbortSignal.timeout(START_WORK_TIMEOUT_MS),
        });
        const json = (await res.json()) as StartWorkResponse;
        setResult(json);
        if (json.started) onStarted?.();
      } catch (err) {
        // A timeout aborts *our* request; it does not stop the server, which may
        // have gone on to create the branch and the PR. Reporting that as "can't
        // reach the dashboard" would name the wrong cause and leave the user not
        // knowing whether anything happened. Rerunning is the way to find out,
        // and is safe — the second run finds whatever the first one made.
        const timedOut = err instanceof DOMException && err.name === "TimeoutError";
        setResult({
          started: false,
          ticket: null,
          pr: null,
          prCreated: false,
          assigned: false,
          statusMoved: false,
          notes: [],
          error: timedOut
            ? "That took longer than 30s. It may still have finished — run it again to find out; it won't open a second PR."
            : "Couldn't reach the dashboard. Is it still running?",
        });
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [onStarted],
  );

  return { pending, result, start, reset };
}
