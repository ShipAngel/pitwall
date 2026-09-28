"use client";

import { severityRank } from "@/lib/view";
import type { SecurityResponse } from "@/types";

type Props = {
  security?: SecurityResponse;
  securityError?: string;
};

export default function SecuritySection({ security, securityError }: Props) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel title="Dependabot Alerts" subtitle="open · vulnerable dependencies">
        {securityError && <ErrorMsg msg={securityError} />}
        {!securityError && !security && <Skeleton />}
        {!securityError &&
          security &&
          (() => {
            const rows = security.repos
              .filter((r) => r.total > 0)
              .sort(
                (a, b) => severityRank(b) - severityRank(a) || b.total - a.total,
              );
            if (rows.length === 0) {
              return (
                <p className="text-sm text-text-muted">
                  No open Dependabot alerts across configured repos.
                </p>
              );
            }
            return (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-text-dim">
                    <th className="pb-2 font-medium">Repo</th>
                    <th className="pb-2 text-right font-medium">Crit</th>
                    <th className="pb-2 text-right font-medium">High</th>
                    <th className="pb-2 text-right font-medium">Mod</th>
                    <th className="pb-2 text-right font-medium">Low</th>
                    <th className="pb-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.repo} className="border-t border-line">
                      <td className="py-2">
                        <a
                          href={`https://github.com/${row.repo}/security/dependabot`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-accent-blue hover:underline"
                        >
                          {row.name}
                        </a>
                      </td>
                      <SeverityCell value={row.critical} tone="text-accent-red" />
                      <SeverityCell value={row.high} tone="text-accent-orange" />
                      <SeverityCell
                        value={row.moderate}
                        tone="text-accent-yellow"
                      />
                      <SeverityCell value={row.low} tone="text-text-muted" />
                      <td className="py-2 text-right font-mono text-text-dim">
                        {row.total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
      </Panel>

      <Panel title="Exposure" subtitle="across configured repos">
        {securityError && <ErrorMsg msg={securityError} />}
        {!securityError && !security && <Skeleton />}
        {!securityError && security && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <SeverityTile
                label="Critical"
                count={security.totals.critical}
                tone="text-accent-red"
              />
              <SeverityTile
                label="High"
                count={security.totals.high}
                tone="text-accent-orange"
              />
              <SeverityTile
                label="Moderate"
                count={security.totals.moderate}
                tone="text-accent-yellow"
              />
              <SeverityTile
                label="Low"
                count={security.totals.low}
                tone="text-text-muted"
              />
            </div>
            <SecuritySummary security={security} />
          </>
        )}
      </Panel>
    </div>
  );
}

function SeverityCell({ value, tone }: { value: number; tone: string }) {
  return (
    <td
      className={`py-2 text-right font-mono ${value > 0 ? tone : "text-text-dim"}`}
    >
      {value > 0 ? value : "—"}
    </td>
  );
}

function SeverityTile({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: string;
}) {
  return (
    <div className="rounded-md border border-line bg-bg-row p-4">
      <div className="text-xs uppercase tracking-wide text-text-muted">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className={`font-mono text-3xl font-semibold ${
            count > 0 ? tone : "text-text-dim"
          }`}
        >
          {count}
        </span>
        <span className="text-xs text-text-muted">alerts</span>
      </div>
    </div>
  );
}

function SecuritySummary({ security }: { security: SecurityResponse }) {
  if (security.totals.total === 0) {
    return (
      <p className="mt-3 text-xs text-accent-green">
        No open Dependabot alerts. All clear.
      </p>
    );
  }
  const affected = security.repos.filter((r) => r.total > 0).length;
  return (
    <p className="mt-3 text-xs text-text-muted">
      <span className="font-mono text-text-primary">
        {security.totals.total}
      </span>{" "}
      open {security.totals.total === 1 ? "alert" : "alerts"} across{" "}
      <span className="font-mono text-text-primary">{affected}</span>{" "}
      {affected === 1 ? "repo" : "repos"}.
    </p>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-bg-panel p-5">
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && <span className="text-xs text-text-muted">{subtitle}</span>}
      </div>
      {children}
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
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded bg-bg-row" />
      ))}
    </div>
  );
}
