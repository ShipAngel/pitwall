import { describe, expect, it } from "vitest";
import {
  buildCyclePoints,
  hasMeaningfulPersonalTotal,
  isActiveAt,
  lastFinite,
  recentCycleNumbers,
  type MyCycleIssue,
  type RawCycle,
} from "./cycles";

const NOW = new Date("2026-07-09T12:00:00Z").getTime(); // inside cycle 54

const cycles: RawCycle[] = [
  { number: 51, startsAt: "2026-06-15T00:00:00Z", endsAt: "2026-06-22T00:00:00Z", scopeHistory: [200], completedScopeHistory: [200] },
  { number: 52, startsAt: "2026-06-22T00:00:00Z", endsAt: "2026-06-29T00:00:00Z", scopeHistory: [234], completedScopeHistory: [140] },
  { number: 53, startsAt: "2026-06-29T00:00:00Z", endsAt: "2026-07-06T00:00:00Z", scopeHistory: [269], completedScopeHistory: [124] },
  { number: 54, startsAt: "2026-07-06T00:00:00Z", endsAt: "2026-07-13T00:00:00Z", scopeHistory: [200, 235], completedScopeHistory: [90, 102] },
  { number: 55, startsAt: "2026-07-13T00:00:00Z", endsAt: "2026-07-20T00:00:00Z", scopeHistory: [10], completedScopeHistory: [0] },
  { number: 56, startsAt: "2026-07-20T00:00:00Z", endsAt: "2026-07-27T00:00:00Z", scopeHistory: [5], completedScopeHistory: [0] },
];

describe("lastFinite", () => {
  it("returns the last finite value", () => {
    expect(lastFinite([1, 2, 3])).toBe(3);
  });
  it("skips trailing null/NaN", () => {
    expect(lastFinite([5, null as unknown as number, NaN])).toBe(5);
  });
  it("returns 0 for null or empty", () => {
    expect(lastFinite(null)).toBe(0);
    expect(lastFinite([])).toBe(0);
  });
});

describe("recentCycleNumbers", () => {
  it("returns the current cycle and the two before it, newest first", () => {
    expect(recentCycleNumbers(cycles, NOW, 3)).toEqual([54, 53, 52]);
  });

  it("excludes future (not-yet-started) cycles", () => {
    const nums = recentCycleNumbers(cycles, NOW, 3);
    expect(nums).not.toContain(55);
    expect(nums).not.toContain(56);
  });

  it("respects the count", () => {
    expect(recentCycleNumbers(cycles, NOW, 2)).toEqual([54, 53]);
  });

  it("falls back to the latest started cycle when none contains now", () => {
    // now sits in the gap after 54 ends but before 55 starts (contiguous here,
    // so use a moment just after 54 ends by picking a doctored gap)
    const gapCycles: RawCycle[] = [
      { number: 60, startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-02T00:00:00Z", scopeHistory: [1], completedScopeHistory: [0] },
      { number: 61, startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-02T00:00:00Z", scopeHistory: [1], completedScopeHistory: [0] },
    ];
    const between = new Date("2026-08-15T00:00:00Z").getTime();
    expect(recentCycleNumbers(gapCycles, between, 3)).toEqual([60]);
  });

  it("returns [] when there are no cycles", () => {
    expect(recentCycleNumbers([], NOW, 3)).toEqual([]);
  });
});

describe("buildCyclePoints", () => {
  const myIssues: MyCycleIssue[] = [
    { estimate: 5, cycle: { number: 54 }, state: { type: "started" } },
    { estimate: 3, cycle: { number: 54 }, state: { type: "completed" } },
    { estimate: null, cycle: { number: 54 }, state: { type: "completed" } },
    { estimate: 8, cycle: { number: 53 }, state: { type: "completed" } },
    { estimate: 2, cycle: null, state: { type: "completed" } }, // no cycle → ignored
  ];

  it("uses the latest scope-history value for team totals", () => {
    const [c54] = buildCyclePoints(cycles, [54], myIssues, NOW);
    expect(c54.teamTotal).toBe(235);
    expect(c54.teamCompleted).toBe(102);
  });

  it("sums the viewer's assigned and completed points per cycle", () => {
    const result = buildCyclePoints(cycles, [54, 53, 52], myIssues, NOW);
    const byNum = Object.fromEntries(result.map((c) => [c.number, c]));
    expect(byNum[54].myTotal).toBe(8); // 5 + 3 (null estimate contributes 0)
    expect(byNum[54].myCompleted).toBe(3); // only the completed one
    expect(byNum[53].myTotal).toBe(8);
    expect(byNum[53].myCompleted).toBe(8);
    expect(byNum[52].myTotal).toBe(0);
    expect(byNum[52].myCompleted).toBe(0);
  });

  it("marks only the cycle containing now as current", () => {
    const result = buildCyclePoints(cycles, [54, 53, 52], myIssues, NOW);
    expect(result.map((c) => c.isCurrent)).toEqual([true, false, false]);
  });

  it("preserves the requested cycle order", () => {
    const result = buildCyclePoints(cycles, [54, 53, 52], myIssues, NOW);
    expect(result.map((c) => c.number)).toEqual([54, 53, 52]);
  });

  it("rounds fractional scope values", () => {
    const frac: RawCycle[] = [
      { number: 70, startsAt: "2026-07-06T00:00:00Z", endsAt: "2026-07-13T00:00:00Z", scopeHistory: [234.6], completedScopeHistory: [99.4] },
    ];
    const [c] = buildCyclePoints(frac, [70], [], NOW);
    expect(c.teamTotal).toBe(235);
    expect(c.teamCompleted).toBe(99);
  });

  it("yields zeroed points for a requested cycle missing from the list", () => {
    const [c] = buildCyclePoints(cycles, [999], [], NOW);
    expect(c).toMatchObject({
      number: 999,
      teamTotal: 0,
      teamCompleted: 0,
      myTotal: 0,
      myCompleted: 0,
      isCurrent: false,
    });
  });

  // The snapshot histories are daily, so the in-progress cycle lags real time.
  // Linear reported 120 done where the last snapshot said 108; live values must
  // win for that cycle, and must NOT be applied to finished ones.
  describe("live team points override", () => {
    const live = new Map([[54, { total: 321, completed: 120 }]]);

    it("prefers live values over the snapshot for the given cycle", () => {
      const [c54] = buildCyclePoints(cycles, [54], myIssues, NOW, live);
      expect(c54.teamCompleted).toBe(120); // not 102, the stale snapshot
      expect(c54.teamTotal).toBe(321); // not 235
    });

    it("leaves cycles without a live entry on their snapshots", () => {
      const result = buildCyclePoints(cycles, [54, 53, 52], myIssues, NOW, live);
      const byNum = Object.fromEntries(result.map((c) => [c.number, c]));
      expect(byNum[53].teamCompleted).toBe(124);
      expect(byNum[53].teamTotal).toBe(269);
      expect(byNum[52].teamCompleted).toBe(140);
      expect(byNum[52].teamTotal).toBe(234);
    });

    it("falls back to snapshots when no live data is supplied", () => {
      const [c54] = buildCyclePoints(cycles, [54], myIssues, NOW, undefined);
      expect(c54.teamCompleted).toBe(102);
      expect(c54.teamTotal).toBe(235);
    });

    it("rounds live values", () => {
      const frac = new Map([[54, { total: 320.5, completed: 119.4 }]]);
      const [c54] = buildCyclePoints(cycles, [54], myIssues, NOW, frac);
      expect(c54.teamTotal).toBe(321);
      expect(c54.teamCompleted).toBe(119);
    });

    it("does not disturb the viewer's own point totals", () => {
      const [c54] = buildCyclePoints(cycles, [54], myIssues, NOW, live);
      expect(c54.myTotal).toBe(8);
      expect(c54.myCompleted).toBe(3);
    });

    it("applies live zeros rather than treating them as missing", () => {
      const zeroed = new Map([[54, { total: 0, completed: 0 }]]);
      const [c54] = buildCyclePoints(cycles, [54], myIssues, NOW, zeroed);
      expect(c54.teamTotal).toBe(0);
      expect(c54.teamCompleted).toBe(0);
    });
  });
});

describe("isActiveAt", () => {
  it("is true only while now falls inside the cycle window", () => {
    const c = cycles.find((x) => x.number === 54)!;
    expect(isActiveAt(c, NOW)).toBe(true);
    expect(isActiveAt(c, new Date("2026-07-01T00:00:00Z").getTime())).toBe(false);
    expect(isActiveAt(c, new Date("2026-07-20T00:00:00Z").getTime())).toBe(false);
  });

  it("is inclusive of both boundaries", () => {
    const c = cycles.find((x) => x.number === 54)!;
    expect(isActiveAt(c, new Date(c.startsAt).getTime())).toBe(true);
    expect(isActiveAt(c, new Date(c.endsAt).getTime())).toBe(true);
  });
});

describe("hasMeaningfulPersonalTotal", () => {
  it("is true for the cycle in progress", () => {
    expect(hasMeaningfulPersonalTotal({ isCurrent: true })).toBe(true);
  });

  it("is false for a closed cycle, whose denominator is unknowable", () => {
    expect(hasMeaningfulPersonalTotal({ isCurrent: false })).toBe(false);
  });

  it("tracks isCurrent across a built cycle set", () => {
    // 54 contains NOW; 53 and 52 are closed.
    const built = buildCyclePoints(cycles, [54, 53, 52], [], NOW);
    expect(built.map(hasMeaningfulPersonalTotal)).toEqual([true, false, false]);
  });

  it("is false for a cycle missing from the list, which is never current", () => {
    const [orphan] = buildCyclePoints(cycles, [999], [], NOW);
    expect(hasMeaningfulPersonalTotal(orphan)).toBe(false);
  });
});
