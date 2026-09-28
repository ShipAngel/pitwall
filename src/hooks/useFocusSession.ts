"use client";

import { useCallback, useRef, useState } from "react";
import type { FocusResponse } from "@/types";

/**
 * Asking the dashboard to bring a terminal to the front.
 *
 * A hook rather than component code because `SessionTable` should hold markup
 * and event binding, and rather than `src/lib` because that layer is pure and
 * never touches the network. This is the one place in the app that issues a
 * mutation, so it is also the one place that has to think about a request
 * failing.
 */

/** Long enough for osascript to walk every window; short enough to not hang. */
const FOCUS_TIMEOUT_MS = 15_000;

export type FocusState = {
  /**
   * The tty currently in flight. Non-null means a request is outstanding, and
   * every row disables — not just this one, or a second click would start an
   * overlapping request whose state the first one's completion would clobber.
   */
  pending: string | null;
  /** The last failure worth reporting, against the row that caused it. */
  problem: { tty: string; detail: string } | null;
  focus: (tty: string) => Promise<void>;
};

export function useFocusSession(): FocusState {
  const [pending, setPending] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ tty: string; detail: string } | null>(null);
  // A ref, not state: it has to be true for the next call in the same tick, and
  // a state update wouldn't have landed yet. The disabled buttons are the user's
  // half of this; the guard is what makes it true for any other caller.
  const inFlight = useRef(false);

  const focus = useCallback(async (tty: string) => {
    // Single-flight. Without this, clicking B while A is in flight lets A's
    // completion clear B's pending state, and the two focus scripts can finish
    // out of order — leaving the wrong terminal in front.
    if (inFlight.current) return;
    inFlight.current = true;
    // Clear first, so a stale "no longer open" can't sit under a row that has
    // since been clicked again.
    setProblem(null);
    setPending(tty);
    try {
      const res = await fetch("/api/sessions/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tty }),
        signal: AbortSignal.timeout(FOCUS_TIMEOUT_MS),
      });
      const json = (await res.json()) as FocusResponse;
      // Success says nothing: the terminal is now in front of you, which is its
      // own confirmation. Only a failure needs words.
      if (!json.focused) setProblem({ tty, detail: json.detail });
    } catch {
      setProblem({ tty, detail: "Couldn't reach the dashboard's focus endpoint." });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }, []);

  return { pending, problem, focus };
}
