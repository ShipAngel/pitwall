"use client";

import type { BadgeKind } from "@/lib/view";

// Exhaustive over BadgeKind on purpose: adding a kind becomes a type error here
// rather than an undefined class name at runtime.
const COLOR: Record<BadgeKind, string> = {
  green: "bg-accent-green/15 text-accent-green border-accent-green/30",
  yellow: "bg-accent-yellow/15 text-accent-yellow border-accent-yellow/30",
  red: "bg-accent-red/15 text-accent-red border-accent-red/30",
  neutral: "bg-bg-row text-text-muted border-line",
  blue: "bg-accent-blue/15 text-accent-blue border-accent-blue/30",
};

/** A state badge. Reserved for state — identifiers are plain coloured links. */
export default function Badge({
  kind,
  children,
}: {
  kind: BadgeKind;
  children: React.ReactNode;
}) {
  return (
    <span
      // shrink-0 and whitespace-nowrap because a badge is a fixed label, not
      // prose: inside a flex row it would otherwise compress or wrap its text
      // when it shares the space, turning "checks cancelled" into two lines.
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide ${COLOR[kind]}`}
    >
      {children}
    </span>
  );
}

/** A badge from a `{ kind, label, detail }` decision, or nothing when there is none. */
export function StateBadge({
  state,
}: {
  state: { kind: BadgeKind; label: string; detail?: string } | null;
}) {
  if (!state) return null;
  return (
    <span title={state.detail}>
      <Badge kind={state.kind}>{state.label}</Badge>
    </span>
  );
}
