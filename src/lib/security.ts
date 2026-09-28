import type { RepoConfig, RepoSecurity } from "@/types";
import { repoAlias } from "./github";

// GitHub caps the vulnerabilityAlerts connection at 100 per page. We don't
// paginate, so the per-severity breakdown is computed from at most this many
// alert nodes per repo; totalCount (the "Total" column) stays exact regardless.
const ALERT_PAGE_SIZE = 100;

/**
 * Builds a single GraphQL query fetching open Dependabot (vulnerable-dependency)
 * alerts for every configured repo, one aliased block each — mirroring the PR
 * query in github.ts so the two routes share the same repo-aliasing scheme.
 */
export function buildSecurityQuery(repos: RepoConfig[]): string {
  const repoBlocks = repos
    .map(
      (r) => `
    ${repoAlias(r.owner, r.name)}: repository(owner: "${r.owner}", name: "${r.name}") {
      vulnerabilityAlerts(states: [OPEN], first: ${ALERT_PAGE_SIZE}) {
        totalCount
        nodes { securityVulnerability { severity } }
      }
    }`,
    )
    .join("\n");

  return `
    query {
      ${repoBlocks}
    }
  `;
}

type AlertsBlock =
  | {
      vulnerabilityAlerts?: {
        totalCount?: number;
        nodes?: Array<{
          securityVulnerability?: { severity?: string | null } | null;
        } | null>;
      };
    }
  | null
  | undefined;

/** Keyed by repoAlias(owner, name); values are opaque until narrowed per repo. */
export type RawSecurityResponse = { [alias: string]: unknown };

/**
 * Reads one repo's alert block out of the raw response and tallies it by
 * severity. A missing/null block (repo we couldn't read, or no alerts) yields
 * all zeros rather than throwing, so one inaccessible repo never sinks the rest.
 */
export function getRepoSecurity(
  data: RawSecurityResponse,
  owner: string,
  name: string,
): RepoSecurity {
  const block = data[repoAlias(owner, name)] as AlertsBlock;
  const alerts = block?.vulnerabilityAlerts;

  let critical = 0;
  let high = 0;
  let moderate = 0;
  let low = 0;
  for (const node of alerts?.nodes ?? []) {
    switch (node?.securityVulnerability?.severity?.toUpperCase()) {
      case "CRITICAL":
        critical++;
        break;
      case "HIGH":
        high++;
        break;
      case "MODERATE":
        moderate++;
        break;
      case "LOW":
        low++;
        break;
    }
  }

  return {
    repo: `${owner}/${name}`,
    owner,
    name,
    total: alerts?.totalCount ?? 0,
    critical,
    high,
    moderate,
    low,
  };
}
