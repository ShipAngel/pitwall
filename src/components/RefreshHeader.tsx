"use client";

import { useEffect, useState } from "react";
import {
  formatInterval,
  formatRelative,
  freshness,
  statusIndicator,
  viewerIdentities,
  type BadgeKind,
} from "@/lib/view";
import WheelMark from "./WheelMark";

type Props = {
  linearName?: string;
  githubLogin?: string;
  loading: boolean;
  /** One timestamp per polled source; the oldest decides what is reported. */
  sourceUpdates: readonly (Date | null)[];
  onRefresh: () => void;
  intervalSeconds: number;
};

// Exhaustive over BadgeKind on purpose: adding a kind becomes a type error here
// rather than an undefined class name at runtime.
const DOT_CLASS: Record<BadgeKind, string> = {
  blue: "bg-accent-blue animate-pulse",
  yellow: "bg-accent-yellow",
  neutral: "bg-text-dim",
  green: "bg-accent-green",
  red: "bg-accent-red",
};

function StatusDot(state: {
  loading: boolean;
  updatedAt: Date | null;
  stalled: boolean;
}) {
  const { kind, label } = statusIndicator(state);
  const cls = DOT_CLASS[kind];
  return (
    <span
      className={`h-2 w-2 shrink-0 rounded-full ${cls}`}
      title={label}
      aria-label={label}
    />
  );
}

/**
 * The wordmark's old "GitHub + Linear" treatment, reused for the source labels.
 *
 * That tagline said the same thing these labels now say, one word away from
 * them, so it went — but the styling is what made it read as a caption rather
 * than content, which is exactly the job here. `tracking-widest` is why the
 * column is wider than the words look like they need.
 */
const LABEL = "inline-block w-16 text-xs font-normal uppercase tracking-widest text-text-dim";

/**
 * Which account each panel is speaking for — rendering only.
 *
 * The derivation is `viewerIdentities`, where it is tested: which sources exist,
 * what stands in for one still loading, and what the profile link is.
 */
function ViewerLine({
  linearName,
  githubLogin,
}: {
  linearName?: string;
  githubLogin?: string;
}) {
  return (
    <span className="flex flex-col gap-0.5 text-xs leading-tight text-text-muted">
      {viewerIdentities(linearName, githubLogin).map((id) => (
        <span key={id.source}>
          <span className={LABEL}>{id.source}</span>
          {id.value === null ? (
            <span className="text-text-dim">…</span>
          ) : id.href ? (
            <a
              href={id.href}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-text-muted hover:text-accent-blue hover:underline"
            >
              {id.value}
            </a>
          ) : (
            <span className="text-text-primary">{id.value}</span>
          )}
        </span>
      ))}
    </span>
  );
}

export default function RefreshHeader({
  linearName,
  githubLogin,
  loading,
  sourceUpdates,
  onRefresh,
  intervalSeconds,
}: Props) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Two missed refresh cycles → treat as stalled and flag it, so a silent
  // failure (sleep, repeated API errors on one endpoint) is visible instead of
  // looking fresh. Judged on the oldest source, so one healthy endpoint can't
  // vouch for the others.
  const { updatedAt, stalled } = freshness(sourceUpdates, intervalSeconds, now);

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
      {/* The viewer line is a sibling of the h1, not inside it. Visually they
          share a row, but nesting it would have made the page's only heading
          announce as "Pitwall GitHub + Linear Signed in as Alex Doe
          @alexdoe" — a heading should name the page, not report state. */}
      {/* A wide gap-x, not the usual 3: the wordmark and the identity block are
          separate things sharing a row, and at close spacing "PITWALL LINEAR"
          read as one run of capitals. The gap is what separates them, since
          there's no rule or panel edge between. */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          {/* Soft-compound red. It shares accent-red with the "failed" badges,
              which is a real cost — but those live in the panels, several inches
              away, and never beside the wordmark. */}
          <WheelMark className="h-6 w-6 text-accent-red" />
          {/* Uppercased in CSS rather than typed in capitals: a screen reader
              announces the accessible text, and "PITWALL" risks being spelled
              out letter by letter where "Pitwall" is read as a word. */}
          <span className="uppercase">Pitwall</span>
        </h1>
        {/* On the wordmark's row rather than a line of its own: who you're
            signed in as is something you check once and then stop reading, so it
            was spending a whole row on a constant. Kept small and unemphasised
            so it reads as context beside the wordmark, not a second title. */}
        <p className="text-sm">
          <ViewerLine linearName={linearName} githubLogin={githubLogin} />
        </p>
      </div>
      <div className="flex items-center gap-3 text-sm text-text-muted">
        <span className="flex items-center gap-1.5">
          <StatusDot loading={loading} updatedAt={updatedAt} stalled={stalled} />
          Updated{" "}
          <span className={stalled ? "text-accent-yellow" : "text-text-primary"}>
            {formatRelative(updatedAt, now)}
          </span>
          {stalled ? (
            <span className="text-accent-yellow">· auto-refresh may be stalled</span>
          ) : (
            <>
              {" · auto every "}
              {formatInterval(intervalSeconds)}
            </>
          )}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-sm border border-line bg-bg-panel px-3 py-1 text-sm text-text-primary transition hover:bg-bg-row disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
    </header>
  );
}
