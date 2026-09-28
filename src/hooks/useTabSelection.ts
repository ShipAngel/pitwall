"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_TAB, parseTab, tabHash, type TabId } from "@/lib/tabs";

/**
 * Which tab is showing, kept in the URL fragment.
 *
 * In a hook rather than `Dashboard` so the component stays markup, and not in
 * `lib/` because it touches `window` — the same split `useFocusSession` follows.
 * The parsing itself *is* in `lib/tabs.ts`, where it can be tested.
 */
export function useTabSelection(): {
  tab: TabId;
  selectTab: (id: TabId) => void;
} {
  // Starts on the default and adopts the fragment after mount, rather than
  // reading `location` during render — the server has no URL to read, and
  // guessing one produces a hydration mismatch.
  const [tab, setTab] = useState<TabId>(DEFAULT_TAB);

  useEffect(() => {
    const fromUrl = () => setTab(parseTab(window.location.hash));
    fromUrl();
    // Keeps up with an edited address bar, and with the back button.
    window.addEventListener("hashchange", fromUrl);
    return () => window.removeEventListener("hashchange", fromUrl);
  }, []);

  const selectTab = useCallback((id: TabId) => {
    setTab(id);
    // replaceState, not a new entry: this dashboard is left open for days, and
    // pushing every glance between tabs would bury the back button.
    window.history.replaceState(null, "", tabHash(id));
  }, []);

  return { tab, selectTab };
}
