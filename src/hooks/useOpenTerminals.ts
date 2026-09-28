"use client";

import { useCallback, useMemo, useState } from "react";
import {
  EMPTY_DOCK,
  closeDockTerminal,
  dockTerminalForPR,
  openDockTerminal,
  type DockState,
} from "@/lib/terminal";
import type { MyPR, OpenTerminal } from "@/types";

/**
 * The terminals the dashboard is hosting, and which one is showing.
 *
 * A hook rather than component code because `Dashboard` should hold markup —
 * the same split `useTabSelection` and `useTerminalDock` follow. It can't be
 * `src/lib`: that layer is pure and this keeps React state. The transitions it
 * dispatches are pure, and do live there, tested without a DOM.
 *
 * These are panes Pitwall owns, not the Claude Code sessions the Sessions panel
 * discovers in your own iTerm2 windows.
 */
export function useOpenTerminals(): {
  terminals: OpenTerminal[];
  activeKey: string | null;
  openTerminal: (pr: MyPR) => void;
  activateTerminal: (key: string) => void;
  closeTerminal: (key: string) => void;
} {
  // One state, not two: the open list and the visible key have to agree, and
  // updating them separately meant nesting one setter inside the other's
  // updater — which React doesn't support, since updaters must be pure.
  const [dock, setDock] = useState<DockState>(EMPTY_DOCK);

  const openTerminal = useCallback((pr: MyPR) => {
    setDock((d) => openDockTerminal(d, dockTerminalForPR(pr)));
  }, []);

  const activateTerminal = useCallback((key: string) => {
    setDock((d) => ({ ...d, activeKey: key }));
  }, []);

  const closeTerminal = useCallback((key: string) => {
    setDock((d) => closeDockTerminal(d, key));
  }, []);

  return useMemo(
    () => ({
      terminals: dock.terminals,
      activeKey: dock.activeKey,
      openTerminal,
      activateTerminal,
      closeTerminal,
    }),
    [dock, openTerminal, activateTerminal, closeTerminal],
  );
}
