/**
 * The two views the dashboard splits into.
 *
 * The page had grown to five stacked sections, which is a lot of scrolling on a
 * portrait monitor — and the two halves answer different questions. The Cockpit
 * is what you act on; Team Pulse is what you check on. Both names are the app's
 * own metaphor: in F1 the pit wall watches from outside while the driver is the
 * one actually going round.
 */

export type TabId = "cockpit" | "teampulse";

export type Tab = {
  id: TabId;
  label: string;
  /** What the tab holds, for its tooltip and accessible description. */
  hint: string;
};

// The id is the URL fragment and it matches the label deliberately: `#cockpit`
// says what you'll be looking at where `#me` needed the app open to decode. The
// cost is that renaming a tab now breaks its bookmarks — acceptable, because
// `parseTab` falls back to the default rather than rendering nothing, so an old
// `#me` link still lands somewhere sensible.
export const TABS: readonly Tab[] = [
  {
    id: "cockpit",
    label: "Cockpit",
    hint: "Your sessions, PRs, reviews and tickets",
  },
  {
    id: "teampulse",
    label: "Team Pulse",
    hint: "Team flow, dependency alerts and cycle points",
  },
];

/** Opening on your own work, since that's the reason to glance at this. */
export const DEFAULT_TAB: TabId = "cockpit";

/**
 * Narrows an untrusted string to a tab.
 *
 * The value comes from the URL, so it is whatever someone typed. Anything
 * unrecognised falls back to the default rather than rendering an empty page.
 */
export function parseTab(raw: string | null | undefined): TabId {
  if (!raw) return DEFAULT_TAB;
  // Trim before stripping the hash, not after: with leading whitespace the `^#`
  // never matches, and "  #teampulse  " falls through to the default.
  const id = raw.trim().replace(/^#/, "").trim().toLowerCase();
  return TABS.some((t) => t.id === id) ? (id as TabId) : DEFAULT_TAB;
}

/**
 * The fragment a tab is addressable by.
 *
 * A URL fragment rather than component state alone, so the choice survives the
 * reloads a dashboard left open for days will get — and so a second window can
 * be pinned to the other tab.
 */
export function tabHash(id: TabId): string {
  return `#${id}`;
}

/**
 * The next tab under an arrow key, wrapping at both ends.
 *
 * A tablist is expected to move under Left/Right rather than Tab, which moves
 * out of it — so this is what makes the tabs usable without a mouse.
 */
export function nextTab(current: TabId, direction: 1 | -1): TabId {
  const index = TABS.findIndex((t) => t.id === current);
  // An unknown current tab shouldn't strand the keyboard user on nothing.
  if (index === -1) return DEFAULT_TAB;
  const next = (index + direction + TABS.length) % TABS.length;
  return TABS[next].id;
}

/** The element ids that tie a tab to its panel for assistive technology. */
export function tabIds(id: TabId): { tab: string; panel: string } {
  return { tab: `tab-${id}`, panel: `panel-${id}` };
}
