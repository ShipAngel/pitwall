import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/types";

const config = (over: Partial<AppConfig> = {}): AppConfig => ({
  repos: [
    { owner: "Northwind", name: "billing-app" },
    { owner: "Northwind", name: "forms-app" },
  ],
  linear: {
    teamKey: "ENG",
  },
  refreshIntervalSeconds: 300,
  ...over,
});

const readConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", () => ({ readConfig }));

const alerts = (total: number, severities: string[]) => ({
  vulnerabilityAlerts: {
    totalCount: total,
    nodes: severities.map((s) => ({ securityVulnerability: { severity: s } })),
  },
});

function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: Array<{ query: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      calls.push({ query: JSON.parse(init.body).query });
      return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
    }),
  );
  return calls;
}

async function callGET() {
  const { GET } = await import("@/app/api/security/route");
  return GET();
}

beforeEach(() => {
  vi.resetModules();
  readConfig.mockResolvedValue(config());
  vi.stubEnv("GITHUB_TOKEN", "gh-test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  readConfig.mockReset();
});

describe("GET /api/security", () => {
  it("500s when the token is missing", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const res = await callGET();
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "GITHUB_TOKEN is not set in .env.local",
    });
  });

  it("tallies severities per repo and totals across them", async () => {
    stubFetch({
      data: {
        repo_Northwind_billing_app: alerts(3, ["CRITICAL", "HIGH", "LOW"]),
        repo_Northwind_forms_app: alerts(2, ["MODERATE", "moderate"]),
      },
    });
    const body = await (await callGET()).json();
    expect(body.repos).toEqual([
      {
        repo: "Northwind/billing-app",
        owner: "Northwind",
        name: "billing-app",
        total: 3,
        critical: 1,
        high: 1,
        moderate: 0,
        low: 1,
      },
      {
        repo: "Northwind/forms-app",
        owner: "Northwind",
        name: "forms-app",
        total: 2,
        critical: 0,
        high: 0,
        moderate: 2, // severity matched case-insensitively
        low: 0,
      },
    ]);
    expect(body.totals).toEqual({ critical: 1, high: 1, moderate: 2, low: 1, total: 5 });
  });

  it("reports zeros for a repo GitHub refused, keeping the others", async () => {
    // GitHub returns readable repos in `data` alongside a partial `errors` array
    // when Dependabot access is denied on one repo. That must not sink the rest.
    stubFetch({
      data: {
        repo_Northwind_billing_app: alerts(2, ["HIGH", "HIGH"]),
        repo_Northwind_forms_app: null,
      },
      errors: [{ message: "Resource not accessible by personal access token" }],
    });
    const res = await callGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos[0]).toMatchObject({ name: "billing-app", total: 2, high: 2 });
    expect(body.repos[1]).toMatchObject({ name: "forms-app", total: 0, high: 0 });
    expect(body.totals.total).toBe(2);
  });

  it("500s with scope guidance when there is no data at all", async () => {
    stubFetch({ errors: [{ message: "Bad credentials" }] });
    const res = await callGET();
    expect(res.status).toBe(500);
    const { error } = await res.json();
    expect(error).toContain("Dependabot");
    expect(error).toContain("'repo' scope");
  });

  it("trusts totalCount over the node count, which is capped at 100", async () => {
    // Only 2 nodes returned but 150 open alerts: the total stays exact while the
    // per-severity split is necessarily partial.
    stubFetch({
      data: {
        repo_Northwind_billing_app: alerts(150, ["CRITICAL", "HIGH"]),
        repo_Northwind_forms_app: alerts(0, []),
      },
    });
    const body = await (await callGET()).json();
    expect(body.repos[0].total).toBe(150);
    expect(body.repos[0].critical + body.repos[0].high).toBe(2);
    expect(body.totals.total).toBe(150);
  });

  it("short-circuits to empty totals when no repos are configured", async () => {
    readConfig.mockResolvedValue(config({ repos: [] }));
    const calls = stubFetch({ data: {} });
    const res = await callGET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      repos: [],
      totals: { critical: 0, high: 0, moderate: 0, low: 0, total: 0 },
    });
    expect(calls).toHaveLength(0); // no point asking GitHub about nothing
  });

  it("500s with the upstream status on an HTTP failure", async () => {
    stubFetch({ message: "rate limited" }, false, 403);
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("GitHub API 403");
  });

  it("ignores unrecognised severity values", async () => {
    stubFetch({
      data: {
        repo_Northwind_billing_app: alerts(2, ["UNKNOWN", null as unknown as string]),
        repo_Northwind_forms_app: alerts(0, []),
      },
    });
    const body = await (await callGET()).json();
    expect(body.repos[0]).toMatchObject({ total: 2, critical: 0, high: 0, moderate: 0, low: 0 });
  });
});
