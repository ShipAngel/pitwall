"use client";

import { useTabKeyboard } from "@/hooks/useTabKeyboard";
import { TABS, tabIds, type TabId } from "@/lib/tabs";

/**
 * The Cockpit / Team Pulse switch — markup and event binding only; the keyboard
 * and focus behaviour lives in `useTabKeyboard`.
 *
 * A real tablist rather than two styled links: arrow keys move between tabs, Tab
 * itself moves out of the list, and each tab names the panel it controls.
 */
export default function Tabs({
  active,
  onChange,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
}) {
  const { registerRef, onKeyDown } = useTabKeyboard(active, onChange);

  return (
    <div
      role="tablist"
      aria-label="Dashboard view"
      className="mt-6 flex gap-1 border-b border-line"
    >
      {TABS.map((t) => {
        const selected = t.id === active;
        const ids = tabIds(t.id);
        return (
          <button
            key={t.id}
            ref={registerRef(t.id)}
            id={ids.tab}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={ids.panel}
            // Roving tabindex: only the selected tab is in the tab order, so Tab
            // leaves the list instead of walking through every tab in it.
            tabIndex={selected ? 0 : -1}
            title={t.hint}
            onClick={() => onChange(t.id)}
            onKeyDown={onKeyDown}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-ui ${
              selected
                ? "border-accent-blue text-text-primary"
                : "border-transparent text-text-muted hover:border-line hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
