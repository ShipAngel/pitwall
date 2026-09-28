import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import {
  buildSecurityQuery,
  getRepoSecurity,
  type RawSecurityResponse,
} from "@/lib/security";
import type { RepoSecurity, SecurityResponse } from "@/types";

export const dynamic = "force-dynamic";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

const EMPTY_TOTALS = {
  critical: 0,
  high: 0,
  moderate: 0,
  low: 0,
  total: 0,
} as const;

export async function GET() {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return NextResponse.json(
        { error: "GITHUB_TOKEN is not set in .env.local" },
        { status: 500 },
      );
    }

    const config = await readConfig();
    if (config.repos.length === 0) {
      const empty: SecurityResponse = { repos: [], totals: { ...EMPTY_TOTALS } };
      return NextResponse.json(empty);
    }

    const query = buildSecurityQuery(config.repos);
    const res = await fetch(GITHUB_GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "dev-dashboard",
      },
      body: JSON.stringify({ query }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      data?: RawSecurityResponse;
      errors?: unknown;
    };

    // vulnerabilityAlerts can be denied per-repo (the token lacks Dependabot read
    // on that repo, or it's archived) while other repos succeed — GitHub returns
    // the readable repos in `data` alongside an `errors` array. Tolerate that:
    // missing repo blocks fall through to zeros in getRepoSecurity. Only bail out
    // when there's no data at all, which means a token/scope problem to fix.
    const data = json.data;
    if (!data) {
      const detail = json.errors
        ? ` (${JSON.stringify(json.errors).slice(0, 300)})`
        : "";
      throw new Error(
        "GitHub returned no security data. The GITHUB_TOKEN likely needs Dependabot " +
          "alerts read access — classic PAT: 'repo' scope; fine-grained: " +
          `'Dependabot alerts' read.${detail}`,
      );
    }

    const repos: RepoSecurity[] = config.repos.map((r) =>
      getRepoSecurity(data, r.owner, r.name),
    );
    const totals = repos.reduce<SecurityResponse["totals"]>(
      (acc, r) => ({
        critical: acc.critical + r.critical,
        high: acc.high + r.high,
        moderate: acc.moderate + r.moderate,
        low: acc.low + r.low,
        total: acc.total + r.total,
      }),
      { ...EMPTY_TOTALS },
    );

    const response: SecurityResponse = { repos, totals };
    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
