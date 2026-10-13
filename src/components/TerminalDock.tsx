"use client";

import { useTerminalDock } from "@/hooks/useTerminalDock";
import { terminalTabLabel } from "@/lib/terminal";
import type { OpenTerminal } from "@/types";
import TerminalPane from "./TerminalPane";

/**
 * The bottom drawer holding one pane per open PR.
 *
 * Every pane stays mounted and only the active one is visible: unmounting would
 * close its socket, and reattaching to tmux replays only the visible screen, so
 * anything Claude Code printed while the tab was hidden would be lost from the
 * scrollback. Hiding costs a little memory per pane and keeps switching instant.
 *
 * These are terminals Pitwall hosts, not the Claude Code sessions the Sessions
 * panel discovers in your own iTerm2 windows.
 *
 * Markup and event binding only — the handshake, the remembered height and the
 * resize drag live in `useTerminalDock`.
 */
export default function TerminalDock({
  terminals,
  activeKey,
  onActivate,
  onClose,
  onHeightChange,
}: {
  terminals: OpenTerminal[];
  activeKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  /** Reported so the page can reserve space beneath its content. 0 when closed. */
  onHeightChange: (height: number) => void;
}) {
  const { isOpen, height, handshake, error, dragHandlers } = useTerminalDock({
    isOpen: terminals.length > 0,
    onHeightChange,
  });

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col border-t border-line bg-bg-base shadow-[0_-8px_24px_rgba(0,0,0,0.5)]"
      style={{ height }}
    >
      <div
        {...dragHandlers}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminals"
        className="group h-1.5 shrink-0 cursor-ns-resize bg-line/50 transition hover:bg-accent-blue/60"
      />

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1">
        {terminals.map((t) => {
          const isActive = t.key === activeKey;
          return (
            <div
              key={t.key}
              className={`flex shrink-0 items-center gap-1 rounded-sm border px-2 py-1 text-xs transition ${
                isActive
                  ? "border-accent-blue/40 bg-accent-blue/15 text-accent-blue"
                  : "border-line bg-bg-panel text-text-muted hover:text-text-primary"
              }`}
            >
              <button
                type="button"
                onClick={() => onActivate(t.key)}
                title={`${t.repo}#${t.prNumber} — ${t.title}\nbranch: ${t.branch}`}
                className="font-mono"
              >
                {terminalTabLabel(t.repo, t.prNumber)}
              </button>
              <button
                type="button"
                onClick={() => onClose(t.key)}
                aria-label={`Detach terminal for ${t.repo}#${t.prNumber}`}
                title="Detach (the tmux session keeps running)"
                className="rounded-sm px-0.5 text-text-dim transition hover:bg-bg-row hover:text-accent-red"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="relative min-h-0 flex-1">
        {error && (
          <p className="p-3 text-sm text-accent-red">{error.message}</p>
        )}
        {!error && !handshake && (
          <p className="p-3 text-sm text-text-muted">Connecting to terminal server…</p>
        )}
        {!error && handshake && !handshake.enabled && (
          <p className="p-3 text-sm text-text-muted">
            Terminals are disabled. Set <code>terminals.enabled</code> to true in
            config.json.
          </p>
        )}
        {!error &&
          handshake?.enabled &&
          terminals.map((t) => (
            <TerminalPane
              key={t.key}
              terminal={t}
              handshake={handshake}
              active={t.key === activeKey}
            />
          ))}
      </div>
    </div>
  );
}
