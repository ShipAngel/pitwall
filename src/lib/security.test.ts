import { describe, expect, it } from "vitest";
import {
  buildSecurityQuery,
  getRepoSecurity,
  type RawSecurityResponse,
} from "./security";
import { repoAlias } from "./github";

describe("buildSecurityQuery", () => {
  it("aliases each configured repo", () => {
    const query = buildSecurityQuery([
      { owner: "Acme", name: "alpha" },
      { owner: "Acme", name: "beta" },
    ]);
    expect(query).toContain('repository(owner: "Acme", name: "alpha")');
    expect(query).toContain('repository(owner: "Acme", name: "beta")');
    expect(query).toContain(repoAlias("Acme", "alpha") + ":");
    expect(query).toContain(repoAlias("Acme", "beta") + ":");
  });

  it("requests open vulnerability alerts with totalCount and severity", () => {
    const query = buildSecurityQuery([{ owner: "x", name: "y" }]);
    expect(query).toContain("vulnerabilityAlerts(states: [OPEN], first: 100)");
    expect(query).toContain("totalCount");
    expect(query).toContain("securityVulnerability { severity }");
  });
});

describe("getRepoSecurity", () => {
  it("counts alerts by severity", () => {
    const data: RawSecurityResponse = {
      [repoAlias("Acme", "alpha")]: {
        vulnerabilityAlerts: {
          totalCount: 4,
          nodes: [
            { securityVulnerability: { severity: "CRITICAL" } },
            { securityVulnerability: { severity: "HIGH" } },
            { securityVulnerability: { severity: "HIGH" } },
            { securityVulnerability: { severity: "LOW" } },
          ],
        },
      },
    };
    expect(getRepoSecurity(data, "Acme", "alpha")).toMatchObject({
      repo: "Acme/alpha",
      owner: "Acme",
      name: "alpha",
      total: 4,
      critical: 1,
      high: 2,
      moderate: 0,
      low: 1,
    });
  });

  it("returns zeros for a repo missing from the response", () => {
    expect(getRepoSecurity({}, "Acme", "missing")).toMatchObject({
      total: 0,
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
    });
  });

  it("tolerates null nodes and missing severities without miscounting", () => {
    const data: RawSecurityResponse = {
      [repoAlias("a", "b")]: {
        vulnerabilityAlerts: {
          totalCount: 2,
          nodes: [null, { securityVulnerability: null }],
        },
      },
    };
    const r = getRepoSecurity(data, "a", "b");
    expect(r.total).toBe(2);
    expect(r.critical + r.high + r.moderate + r.low).toBe(0);
  });

  it("matches severity case-insensitively", () => {
    const data: RawSecurityResponse = {
      [repoAlias("a", "b")]: {
        vulnerabilityAlerts: {
          totalCount: 1,
          nodes: [{ securityVulnerability: { severity: "critical" } }],
        },
      },
    };
    expect(getRepoSecurity(data, "a", "b").critical).toBe(1);
  });
});
