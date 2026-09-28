import { describe, expect, it } from "vitest";
import { filterPRsToConfiguredRepos, groupPRsByRepo } from "./grouping";
import type { MyPR, RepoConfig } from "@/types";

const repos: RepoConfig[] = [
  { owner: "Acme", name: "frontend" },
  { owner: "Acme", name: "backend" },
];

const pr = (overrides: Partial<MyPR> = {}): MyPR => ({
  repo: "Acme/frontend",
  url: "https://example.com/1",
  title: "Test PR",
  number: 1,
  isDraft: false,
  headRefName: "feature/test",
  isCrossRepository: false,
  mergeStateStatus: "CLEAN" as const,
  ciState: "SUCCESS" as const,
  mergeQueue: null,
  reviewDecision: null,
  createdAt: "2026-01-01T00:00:00Z",
  isWip: false,
  ...overrides,
});

describe("groupPRsByRepo", () => {
  it("groups PRs into the matching repo", () => {
    const result = groupPRsByRepo(
      [pr({ repo: "Acme/frontend", number: 1 }), pr({ repo: "Acme/backend", number: 2 })],
      repos,
    );
    expect(result).toHaveLength(2);
    expect(result[0].prs.map((p) => p.number)).toEqual([1]);
    expect(result[1].prs.map((p) => p.number)).toEqual([2]);
  });

  it("matches case-insensitively when GitHub returns canonical case", () => {
    const result = groupPRsByRepo(
      [pr({ repo: "ACME/FRONTEND" })],
      [{ owner: "acme", name: "frontend" }],
    );
    expect(result[0].prs).toHaveLength(1);
  });

  it("preserves the order of repos from config", () => {
    const result = groupPRsByRepo([], repos);
    expect(result.map((g) => g.repo.name)).toEqual(["frontend", "backend"]);
  });

  it("returns empty arrays for repos without PRs", () => {
    const result = groupPRsByRepo([pr({ repo: "Acme/frontend" })], repos);
    expect(result[1].prs).toEqual([]);
  });

  it("ignores PRs from repos not in config", () => {
    const result = groupPRsByRepo(
      [pr({ repo: "Other/random-repo" }), pr({ repo: "Acme/frontend" })],
      repos,
    );
    const allPrs = result.flatMap((g) => g.prs);
    expect(allPrs).toHaveLength(1);
    expect(allPrs[0].repo).toBe("Acme/frontend");
  });
});

describe("filterPRsToConfiguredRepos", () => {
  it("keeps only PRs in configured repos", () => {
    const result = filterPRsToConfiguredRepos(
      [
        pr({ repo: "Acme/frontend", number: 1 }),
        pr({ repo: "Other/extra", number: 99 }),
        pr({ repo: "Acme/backend", number: 2 }),
      ],
      repos,
    );
    expect(result.map((p) => p.number).sort()).toEqual([1, 2]);
  });

  it("is case-insensitive on owner and repo", () => {
    const result = filterPRsToConfiguredRepos(
      [pr({ repo: "ACME/Frontend" })],
      [{ owner: "acme", name: "frontend" }],
    );
    expect(result).toHaveLength(1);
  });

  it("returns empty list when nothing matches", () => {
    const result = filterPRsToConfiguredRepos([pr({ repo: "Nope/zzz" })], repos);
    expect(result).toEqual([]);
  });
});
