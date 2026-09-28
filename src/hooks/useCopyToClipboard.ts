"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long the confirmation tick stays up before the button reverts. */
const CONFIRM_MS = 1200;

/**
 * Copy text, and flag success briefly so a button can confirm it.
 *
 * Pulled out of `CopyButton` when a second caller appeared: the timer, its
 * cleanup and the silent-failure rule are the fiddly parts, and two copies of
 * them would drift.
 *
 * The timeout is cleared on unmount because rows come and go on every refresh —
 * a pending timer would otherwise call setState on a component that has gone.
 *
 * `navigator.clipboard` needs a secure context. Pitwall runs on
 * http://localhost, which browsers count as secure, but a failure leaves
 * `copied` false rather than throwing inside a click handler: reporting a copy
 * that didn't happen is worse than saying nothing.
 */
export function useCopyToClipboard(): {
  copied: boolean;
  copy: (text: string) => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    // Assigned on mount, not just at the ref's initial value: React remounts
    // effects in StrictMode, and a ref left false from the first teardown would
    // make every later copy a no-op.
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // The write is asynchronous and the rows around it are replaced on every
      // refresh, so the component can be gone by the time it resolves. Without
      // this the continuation would set state on a dead component *and* start a
      // timer that the cleanup has already run past — the exact leak the
      // cleanup exists to prevent, reopened one line later.
      if (!mounted.current) return;
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
    } catch {
      // Clipboard unavailable or permission denied.
    }
  }, []);

  return { copied, copy };
}
