import type { AppConfig, RepoConfig } from "@/types";

/**
 * The repo config for "owner/name", or null when it isn't configured.
 *
 * Case-insensitive, like GitHub itself: config.json may say `acme/api` while
 * GitHub reports `Acme/api`. Anything built from the result (tmux session names,
 * worktree paths) must use the config's spelling, `repoId(found)`, never the
 * caller's, or the same PR gets two names depending on who asked.
 */
export function findConfiguredRepo(config: AppConfig, repo: string): RepoConfig | null {
  return (
    config.repos.find((r) => repoId(r).toLowerCase() === repo.toLowerCase()) ?? null
  );
}

/** "owner/name", in the spelling config.json uses. */
export function repoId(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}
