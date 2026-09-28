"use client";

import { useCallback, useEffect, useRef } from "react";
import { nextTab, type TabId } from "@/lib/tabs";

/**
 * Keyboard behaviour for a tablist: arrow keys move the selection, and focus
 * follows it.
 *
 * Both halves matter. A tablist is expected to move under Left/Right rather than
 * Tab, which leaves the list — and if focus doesn't follow, the keyboard user is
 * left with focus parked on a tab that is no longer the selected one.
 *
 * The direction arithmetic lives in `lib/tabs.ts` and is tested there; what's
 * here is the DOM interaction that can't be.
 */
export function useTabKeyboard(active: TabId, onChange: (id: TabId) => void) {
  const refs = useRef(new Map<TabId, HTMLButtonElement | null>());
  // Only move focus when the change came from a key. A click already put focus
  // where the user meant it, and stealing it back is at best redundant.
  const movedByKey = useRef(false);

  useEffect(() => {
    if (!movedByKey.current) return;
    movedByKey.current = false;
    refs.current.get(active)?.focus();
  }, [active]);

  const registerRef = useCallback(
    (id: TabId) => (el: HTMLButtonElement | null) => {
      refs.current.set(id, el);
    },
    [],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const direction =
        event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (direction === 0) return;
      // Stop the arrow from also scrolling the page under the tablist.
      event.preventDefault();
      movedByKey.current = true;
      onChange(nextTab(active, direction));
    },
    [active, onChange],
  );

  return { registerRef, onKeyDown };
}
