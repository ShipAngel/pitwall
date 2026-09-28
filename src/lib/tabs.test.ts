import { describe, expect, it } from "vitest";
import {
  DEFAULT_TAB,
  TABS,
  nextTab,
  parseTab,
  tabHash,
  tabIds,
  type TabId,
} from "./tabs";

describe("TABS", () => {
  it("offers exactly the two views the page splits into", () => {
    expect(TABS.map((t) => t.id)).toEqual(["cockpit", "teampulse"]);
  });

  it("opens on your own work", () => {
    expect(DEFAULT_TAB).toBe("cockpit");
    expect(TABS.some((t) => t.id === DEFAULT_TAB)).toBe(true);
  });

  it("gives every tab a label and a hint", () => {
    for (const t of TABS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.hint.length).toBeGreaterThan(0);
    }
  });

  it("uses the app's own metaphor for the labels", () => {
    // Pinned so a rename is a deliberate edit here rather than a drive-by.
    expect(TABS.map((t) => t.label)).toEqual(["Cockpit", "Team Pulse"]);
  });

  it("keeps the fragment short and stable even as labels change", () => {
    // The id is what ends up in a bookmarked URL, so it does not track the
    // label — "Team Pulse" stays addressable as #teampulse.
    expect(TABS.map((t) => t.id)).toEqual(["cockpit", "teampulse"]);
  });
});

describe("parseTab", () => {
  it("reads a fragment with or without its hash", () => {
    expect(parseTab("#teampulse")).toBe("teampulse");
    expect(parseTab("teampulse")).toBe("teampulse");
    expect(parseTab("#cockpit")).toBe("cockpit");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(parseTab("#TEAMPULSE")).toBe("teampulse");
    expect(parseTab("  #TeamPulse  ")).toBe("teampulse");
  });

  // The ids used to be `me` and `team`, and renaming them to match the labels
  // broke any bookmark carrying the old ones. That was accepted on the basis
  // that an unknown fragment lands on the default rather than rendering nothing
  // — so it is worth pinning that it actually does.
  it("lands a bookmark from the old ids on the default tab", () => {
    expect(parseTab("#me")).toBe(DEFAULT_TAB);
    expect(parseTab("#team")).toBe(DEFAULT_TAB);
  });

  it("falls back to the default rather than rendering nothing", () => {
    // The value comes off the URL, so it is whatever someone typed.
    expect(parseTab("#nonsense")).toBe(DEFAULT_TAB);
    expect(parseTab("#")).toBe(DEFAULT_TAB);
    expect(parseTab("")).toBe(DEFAULT_TAB);
    expect(parseTab(null)).toBe(DEFAULT_TAB);
    expect(parseTab(undefined)).toBe(DEFAULT_TAB);
  });

  it("round-trips every tab through its own hash", () => {
    for (const t of TABS) {
      expect(parseTab(tabHash(t.id))).toBe(t.id);
    }
  });
});

describe("tabHash", () => {
  it("is a fragment", () => {
    expect(tabHash("teampulse")).toBe("#teampulse");
  });
});

describe("nextTab", () => {
  it("moves right", () => {
    expect(nextTab("cockpit", 1)).toBe("teampulse");
  });

  it("moves left", () => {
    expect(nextTab("teampulse", -1)).toBe("cockpit");
  });

  it("wraps at both ends", () => {
    // A tablist is expected to cycle, not stop dead at the edges.
    expect(nextTab("teampulse", 1)).toBe("cockpit");
    expect(nextTab("cockpit", -1)).toBe("teampulse");
  });

  it("returns to the default from an unknown tab", () => {
    expect(nextTab("nope" as TabId, 1)).toBe(DEFAULT_TAB);
  });

  it("returns to the start after a full cycle in either direction", () => {
    let id: TabId = "cockpit";
    for (let i = 0; i < TABS.length; i++) id = nextTab(id, 1);
    expect(id).toBe("cockpit");
    for (let i = 0; i < TABS.length; i++) id = nextTab(id, -1);
    expect(id).toBe("cockpit");
  });
});

describe("tabIds", () => {
  it("pairs a tab with the panel it controls", () => {
    expect(tabIds("cockpit")).toEqual({ tab: "tab-cockpit", panel: "panel-cockpit" });
  });

  it("keeps every id distinct, so aria-controls can't cross-wire", () => {
    const all = TABS.flatMap((t) => Object.values(tabIds(t.id)));
    expect(new Set(all).size).toBe(all.length);
  });
});
