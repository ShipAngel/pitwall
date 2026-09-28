"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { DOCK_DEFAULT_HEIGHT, clampDockHeight, clampDragHeight } from "@/lib/terminal";
import type { TerminalHandshake } from "@/types";

/**
 * The dock's own behaviour: the socket handshake, the remembered height, and the
 * drag that changes it.
 *
 * A hook rather than component code because `TerminalDock` should hold markup —
 * the same split as `useFocusSession` and `useTerminalSocket`. It can't be
 * `src/lib`: that layer is pure, and this fetches, reads localStorage and keeps
 * React state. The arithmetic it needs (clamping) does live there, and is tested
 * there.
 */

const HEIGHT_KEY = "pitwall.terminalDockHeight";

const handshakeFetcher = async (url: string): Promise<TerminalHandshake> => {
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `Request failed: ${res.status}`);
  return json;
};

/**
 * Reads the stored height at first render rather than in an effect, which would
 * cost a second render and trip react-hooks/set-state-in-effect.
 *
 * Safe despite SSR: the dock only renders once a terminal is open, and the list
 * starts empty, so it never exists during the server render or hydration.
 */
function initialHeight(): number {
  if (typeof window === "undefined") return DOCK_DEFAULT_HEIGHT;
  return clampDockHeight(window.localStorage.getItem(HEIGHT_KEY));
}

/** Pointer handlers for the resize grip, ready to spread onto it. */
export type DragHandlers = {
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  /**
   * A drag the browser took away from us — a touch that became a scroll, or the
   * pointer being interrupted. `pointerup` does not follow it, so without this
   * the drag state stays set and the next stray `pointermove` over the grip
   * resumes resizing without anyone having pressed anything.
   */
  onPointerCancel: () => void;
};

export type TerminalDockState = {
  isOpen: boolean;
  height: number;
  handshake: TerminalHandshake | undefined;
  error: Error | undefined;
  dragHandlers: DragHandlers;
};

export function useTerminalDock({
  isOpen,
  onHeightChange,
}: {
  isOpen: boolean;
  onHeightChange: (height: number) => void;
}): TerminalDockState {
  const [height, setHeight] = useState(initialHeight);
  const dragFrom = useRef<{ y: number; height: number } | null>(null);

  // The handshake is only fetched once something is open, so a dashboard with no
  // terminals never asks the sidecar for anything.
  const { data: handshake, error } = useSWR<TerminalHandshake>(
    isOpen ? "/api/terminal" : null,
    handshakeFetcher,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  useEffect(() => {
    onHeightChange(isOpen ? height : 0);
  }, [isOpen, height, onHeightChange]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Capture, so a fast drag that leaves the 6px grip keeps sending moves.
      e.currentTarget.setPointerCapture(e.pointerId);
      dragFrom.current = { y: e.clientY, height };
    },
    [height],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const from = dragFrom.current;
    if (!from) return;
    // Dragging up grows the dock, so the delta is inverted.
    setHeight(clampDragHeight(from.height + (from.y - e.clientY)));
  }, []);

  // Release and cancel end the drag the same way. `height` already holds whatever
  // the last move set, which is what is on screen, so both persist it — leaving
  // the stored value behind the visible one would be the surprise.
  const endDrag = useCallback(() => {
    // Persist on release rather than on every move — a drag is hundreds of
    // events, and only where it ends is worth remembering.
    if (dragFrom.current) window.localStorage.setItem(HEIGHT_KEY, String(height));
    dragFrom.current = null;
  }, [height]);

  return {
    isOpen,
    height,
    handshake,
    error: error instanceof Error ? error : undefined,
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
