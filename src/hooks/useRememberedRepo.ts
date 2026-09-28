"use client";

import { useCallback, useSyncExternalStore } from "react";
import { pickInitialRepo } from "@/lib/startWork";
import type { RepoConfig } from "@/types";

/**
 * The repo the Start Work form is pointed at, remembered across reloads.
 *
 * Worth remembering at all because the repo list is long — seventeen here — and
 * you work in the same one or two for weeks.
 *
 * `useSyncExternalStore` rather than `useState(() => localStorage.getItem(...))`,
 * which is what the dock's height does. The dock gets away with it because it
 * only renders once a terminal is open, so it never exists during the server
 * render; this card is on the page from the first paint. Reading storage in the
 * initializer would mean the server picked the first repo while the browser
 * picked the stored one, and a controlled `<select>` given two different values
 * is a hydration mismatch.
 *
 * A mount effect would also fix it, but `react-hooks/set-state-in-effect` is an
 * error in this repo, and rightly — this is the hook that exists for the job.
 * React uses the server snapshot through hydration and re-reads afterwards.
 */

const REPO_KEY = "pitwall.startWorkRepo";

/**
 * `storage` fires only in *other* tabs, so a write here has to tell its own
 * subscribers. Keeping the set at module scope makes `subscribe` a stable
 * reference, which `useSyncExternalStore` requires — an inline one would
 * resubscribe on every render.
 */
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/** Strings compare by value, so an unchanged key can't loop the store. */
function readStored(): string | null {
  return window.localStorage.getItem(REPO_KEY);
}

/** Nothing is remembered on the server, so the first configured repo wins. */
function readServer(): string | null {
  return null;
}

export function useRememberedRepo(
  repos: RepoConfig[],
): [string, (repo: string) => void] {
  const stored = useSyncExternalStore(subscribe, readStored, readServer);
  // Validated on the way out, not on the way in: a repo dropped from config.json
  // since the last visit would otherwise select an option that isn't there.
  const repo = pickInitialRepo(stored, repos);

  const setRepo = useCallback((next: string) => {
    window.localStorage.setItem(REPO_KEY, next);
    for (const notify of listeners) notify();
  }, []);

  return [repo, setRepo];
}
