import type { MyPR, RepoConfig } from "@/types";

export type RepoGroup = { repo: RepoConfig; prs: MyPR[] };

export function groupPRsByRepo(prs: MyPR[], repos: RepoConfig[]): RepoGroup[] {
  const byKey = new Map<string, MyPR[]>();
  for (const pr of prs) {
    const key = pr.repo.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(pr);
  }
  return repos.map((r) => {
    const key = `${r.owner}/${r.name}`.toLowerCase();
    return { repo: r, prs: byKey.get(key) ?? [] };
  });
}

export function filterPRsToConfiguredRepos(
  prs: MyPR[],
  repos: RepoConfig[],
): MyPR[] {
  const allowed = new Set(
    repos.map((r) => `${r.owner}/${r.name}`.toLowerCase()),
  );
  return prs.filter((p) => allowed.has(p.repo.toLowerCase()));
}
