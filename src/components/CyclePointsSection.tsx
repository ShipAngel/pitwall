"use client";

import { hasMeaningfulPersonalTotal, RECENT_CYCLE_COUNT } from "@/lib/cycles";
import { formatCycleRange, meterPercent } from "@/lib/view";
import type { CyclePoints, LinearResponse } from "@/types";

function Meter({ value, total, color }: { value: number; total: number; color: string }) {
  const pct = meterPercent(value, total);
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-bg-panel">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function CycleCard({ cycle }: { cycle: CyclePoints }) {
  const showPersonalRatio = hasMeaningfulPersonalTotal(cycle);
  return (
    <div className="rounded-md border border-line bg-bg-row p-4">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-sm font-semibold text-text-primary">
          Cycle {cycle.number}
        </span>
        {cycle.isCurrent && (
          <span className="inline-flex items-center rounded border border-accent-blue/30 bg-accent-blue/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-blue">
            current
          </span>
        )}
      </div>
      <div className="mt-0.5 text-xs text-text-dim">
        {formatCycleRange(cycle.startsAt, cycle.endsAt)}
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between text-xs text-text-muted">
          <span>Team</span>
          <span>
            <span className="font-mono text-text-primary">{cycle.teamCompleted}</span>
            <span className="text-text-dim"> / {cycle.teamTotal}</span> pts
          </span>
        </div>
        <Meter value={cycle.teamCompleted} total={cycle.teamTotal} color="bg-accent-green" />
      </div>

      <div className="mt-3">
        <div className="flex items-baseline justify-between text-xs text-text-muted">
          <span>You did</span>
          <span>
            <span className="font-mono text-accent-blue">{cycle.myCompleted}</span>
            {showPersonalRatio && (
              <span className="text-text-dim"> / {cycle.myTotal}</span>
            )}{" "}
            pts
          </span>
        </div>
        {showPersonalRatio ? (
          <Meter
            value={cycle.myCompleted}
            total={cycle.myTotal}
            color="bg-accent-blue"
          />
        ) : (
          // Closed cycle: the denominator isn't knowable, so no ratio and no
          // meter. The spacer keeps the card the same height as a current one.
          <div className="mt-1 h-1.5" />
        )}
      </div>
    </div>
  );
}

export default function CyclePointsSection({
  linear,
  linearError,
}: {
  linear?: LinearResponse;
  linearError?: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-bg-panel p-5">
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Cycle Points</h2>
        <span className="text-xs text-text-muted">
          points · team &amp; you
        </span>
      </div>

      {linearError && <ErrorMsg msg={linearError} />}
      {!linearError && !linear && <Skeleton />}
      {!linearError && linear && linear.cyclePoints.length === 0 && (
        <p className="text-sm text-text-muted">No cycle data for this team.</p>
      )}
      {!linearError && linear && linear.cyclePoints.length > 0 && (
        // Two up then four: four across a narrow window squeezes the point
        // totals, which are the numbers the card exists to show.
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {linear.cyclePoints.map((c) => (
            <CycleCard key={c.number} cycle={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorMsg({ msg }: { msg: string }) {
  return (
    <p className="rounded border border-accent-red/30 bg-accent-red/10 p-3 text-sm text-accent-red">
      {msg}
    </p>
  );
}

function Skeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: RECENT_CYCLE_COUNT }, (_, i) => i).map((i) => (
        <div key={i} className="h-32 animate-pulse rounded-md bg-bg-row" />
      ))}
    </div>
  );
}
