"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  CLOSE_SESSION_ENDED,
  CLOSE_SESSION_FAILED,
  terminalSocketUrl,
} from "@/lib/terminal";
import type { OpenTerminal, TerminalHandshake } from "@/types";

/**
 * An xterm bound to one tmux session over one WebSocket.
 *
 * A hook rather than component code because `TerminalPane` should hold markup,
 * and rather than `src/lib` because that layer is pure and never touches the
 * network — the same split as `useFocusSession`.
 */

/**
 * "detached" and "failed" are deliberately separate. Detaching leaves the tmux
 * session running, so reattaching gets the work back; a failed session never
 * started, and telling the user it is "still running" sends them looking for
 * something that isn't there.
 */
export type TerminalStatus =
  | "connecting"
  | "open"
  | "detached"
  | "ended"
  | "failed"
  | "error";

/** Matches the dashboard's palette, so the terminal reads as part of the page. */
const THEME = {
  background: "#0b0d10",
  foreground: "#e6e9ee",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#181d23",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#a371f7",
  cyan: "#39c5cf",
  white: "#e6e9ee",
} as const;

export type TerminalSocket = {
  /** Attach to the element the terminal should render into. */
  hostRef: React.RefObject<HTMLDivElement>;
  status: TerminalStatus;
  reconnect: () => void;
};

export function useTerminalSocket({
  terminal,
  handshake,
  active,
}: {
  terminal: OpenTerminal;
  handshake: TerminalHandshake;
  active: boolean;
}): TerminalSocket {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  // Bumped by reconnect(). Changing it re-runs the effect, which is the whole
  // reconnect mechanism — there is no retry loop, because a failing session
  // would otherwise hammer the sidecar unattended in a background tab.
  const [generation, setGeneration] = useState(0);

  const { wsUrl, token } = handshake;
  const { repo, prNumber, branch } = terminal;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // A re-run means a new socket, so the old outcome no longer describes
    // anything. Without this a pane that was "detached" or "failed" keeps that
    // line — and its Reconnect button — while already reconnecting. reconnect()
    // sets this itself; the dependency-driven re-runs (a fresh token after the
    // sidecar restarts, say) are what need it here.
    setStatus("connecting");

    let disposed = false;
    let term: Terminal | null = null;
    let socket: WebSocket | null = null;
    let observer: ResizeObserver | null = null;

    // xterm touches `window` on import, so it can't be a top-level import in a
    // tree Next also renders on the server.
    void (async () => {
      const [{ Terminal: XTerm }, { FitAddon: Fit }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;

      term = new XTerm({
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: true,
        // Claude Code redraws a lot; a deep buffer makes scrolling back useful.
        scrollback: 10_000,
        theme: THEME,
        allowProposedApi: true,
      });
      const fit = new Fit();
      term.loadAddon(fit);
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;

      // Only meaningful once the pane has a size; a hidden pane measures as zero.
      if (active) {
        try {
          fit.fit();
        } catch {
          // Not laid out yet — the ResizeObserver below will fit it.
        }
      }

      socket = new WebSocket(
        terminalSocketUrl({
          wsUrl,
          token,
          repo,
          prNumber,
          branch,
          cols: term.cols,
          rows: term.rows,
        }),
      );
      socketRef.current = socket;

      socket.onopen = () => setStatus("open");

      socket.onmessage = (event: MessageEvent<string>) => {
        term?.write(event.data);
      };

      socket.onerror = () => setStatus("error");

      socket.onclose = (event: CloseEvent) => {
        // A reconnect tears this effect down and builds a new socket, and the
        // old one's close lands afterwards. Without this guard it overwrites the
        // new socket's status — so hitting Reconnect could leave a live terminal
        // reading "detached".
        if (disposed) return;
        if (event.reason === CLOSE_SESSION_FAILED) {
          setStatus("failed");
          return;
        }
        // Told apart deliberately. The pty exits both when you detach and when
        // the session is killed, and only the sidecar can ask tmux which — so
        // "detached" here would promise a session to go back to that may have
        // just been ended.
        if (event.reason === CLOSE_SESSION_ENDED) {
          setStatus("ended");
          return;
        }
        // A socket that errored keeps that status: "detached" would imply a
        // session exists to go back to.
        setStatus((s) => (s === "error" ? s : "detached"));
      };

      // Keystrokes go as binary frames, control messages as text. The sidecar
      // splits them by frame type, so input never needs escaping.
      term.onData((data) => {
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(new TextEncoder().encode(data));
        }
      });

      const sendSize = () => {
        if (!term || socket?.readyState !== WebSocket.OPEN) return;
        socket.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
      };

      observer = new ResizeObserver(() => {
        if (!fitRef.current || host.clientWidth === 0 || host.clientHeight === 0) {
          return;
        }
        try {
          fitRef.current.fit();
          sendSize();
        } catch {
          // Mid-layout; the next observation will do it.
        }
      });
      observer.observe(host);
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      // 1000: a deliberate detach. The tmux session stays running.
      if (socket && socket.readyState <= WebSocket.OPEN) {
        socket.close(1000, "pane-closed");
      }
      socketRef.current = null;
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // `active` is deliberately absent: it changes on every tab switch, and
    // re-running this would tear down the socket and lose the attachment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, token, repo, prNumber, branch, generation]);

  // A pane that was hidden has been measuring zero, so it needs a fit and the
  // keyboard the moment it becomes the visible one.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Not laid out yet.
      }
      termRef.current?.focus();
      const term = termRef.current;
      const socket = socketRef.current;
      if (term && socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
      }
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  const reconnect = useCallback(() => {
    setStatus("connecting");
    setGeneration((g) => g + 1);
  }, []);

  return { hostRef, status, reconnect };
}
