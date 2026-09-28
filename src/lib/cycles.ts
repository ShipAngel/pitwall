import type { CyclePoints } from "@/types";

export type RawCycle = {
  number: number;
  startsAt: string;
  endsAt: string;
  scopeHistory: number[] | null;
  completedScopeHistory: number[] | null;
};

export type MyCycleIssue = {
  estimate: number | null;
  cycle: { number: number } | null;
  state: { type: string };
};

/** Last finite value in a history array (Linear appends a daily snapshot). */
export function lastFinite(arr: number[] | null | undefined): number {
  if (!arr) return 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

export function isActiveAt(cycle: RawCycle, nowMs: number): boolean {
  return (
    new Date(cycle.startsAt).getTime() <= nowMs &&
    nowMs <= new Date(cycle.endsAt).getTime()
  );
}

/**
 * How many cycles the Velocity panel shows, newest first.
 *
 * Named rather than passed as a literal because the number has to agree in two
 * places — the route asks for this many, and the grid is laid out to hold them.
 * They drifted apart the moment one was changed without the other.
 */
export const RECENT_CYCLE_COUNT = 4;

/**
 * The `count` most recent cycle numbers up to and including the current one,
 * newest first. "Current" is the cycle containing `nowMs`; if none contains it
 * (shouldn't happen with contiguous cycles), the latest already-started cycle.
 * Future cycles (not yet started) are excluded.
 */
export function recentCycleNumbers(
  cycles: RawCycle[],
  nowMs: number,
  count = 3,
): number[] {
  if (cycles.length === 0) return [];
  const started = cycles.filter((c) => new Date(c.startsAt).getTime() <= nowMs);
  const current =
    cycles.find((c) => isActiveAt(c, nowMs)) ??
    [...started].sort((a, b) => b.number - a.number)[0];
  if (!current) return [];
  return cycles
    .filter((c) => c.number <= current.number)
    .sort((a, b) => b.number - a.number)
    .slice(0, count)
    .map((c) => c.number);
}

/**
 * Whether a cycle's personal "you did X of Y" ratio means anything.
 *
 * Only for the cycle in progress. When a cycle closes Linear moves unfinished
 * issues into the next one, so the viewer's issues remaining in a closed cycle
 * are essentially just the completed ones — `myTotal` collapses toward
 * `myCompleted` and the ratio reads as ~100% no matter what was actually
 * assigned at the time. Linear exposes no per-user historical scope, so the
 * denominator is genuinely unknowable after the fact; showing the completed
 * figure alone is the honest option.
 *
 * Kept as a named predicate rather than an inline `cycle.isCurrent` so the
 * reason survives — the check looks arbitrary without it.
 */
export function hasMeaningfulPersonalTotal(cycle: {
  isCurrent: boolean;
}): boolean {
  return cycle.isCurrent;
}

/**
 * Combine team cycle scope with the viewer's own issues to produce per-cycle
 * point totals, in the order of `numbers`.
 *
 * Team scope comes from Linear's history fields, which are daily snapshots and
 * therefore lag real time for the cycle in progress. `liveTeamPoints` overrides
 * them per cycle number — the route supplies it for the active cycle only, since
 * a live sum on a *finished* cycle undercounts scope (Linear rolls unfinished
 * issues into the next cycle, so only completed work stays behind).
 */
export function buildCyclePoints(
  cycles: RawCycle[],
  numbers: number[],
  myIssues: MyCycleIssue[],
  nowMs: number,
  liveTeamPoints?: Map<number, { total: number; completed: number }>,
): CyclePoints[] {
  const byNumber = new Map(cycles.map((c) => [c.number, c]));

  const mine = new Map<number, { total: number; completed: number }>();
  for (const issue of myIssues) {
    const n = issue.cycle?.number;
    if (n == null) continue;
    const est = issue.estimate ?? 0;
    const acc = mine.get(n) ?? { total: 0, completed: 0 };
    acc.total += est;
    if (issue.state.type === "completed") acc.completed += est;
    mine.set(n, acc);
  }

  return numbers.map((n) => {
    const c = byNumber.get(n);
    const m = mine.get(n) ?? { total: 0, completed: 0 };
    const live = liveTeamPoints?.get(n);
    return {
      number: n,
      isCurrent: c ? isActiveAt(c, nowMs) : false,
      startsAt: c?.startsAt ?? "",
      endsAt: c?.endsAt ?? "",
      teamTotal: live
        ? Math.round(live.total)
        : Math.round(lastFinite(c?.scopeHistory)),
      teamCompleted: live
        ? Math.round(live.completed)
        : Math.round(lastFinite(c?.completedScopeHistory)),
      myTotal: m.total,
      myCompleted: m.completed,
    };
  });
}
