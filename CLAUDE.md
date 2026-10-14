# Pitwall — working notes

A local Next.js dashboard (port 3737) over the GitHub and Linear APIs. Reads
everywhere except **Start Work**, which is the one feature that mutates
upstream — see its section below before touching it. Two other things act on
your own machine instead of reading an API:
the **Sessions panel**, where clicking a row focuses that iTerm2 window, and
**per-PR terminals**, which run a shell in a git worktree — that one is off
unless `terminals.enabled` says otherwise, and it is the bigger of the two by
some distance.
See `README.md` for setup and what each panel shows; this file is the stuff worth
knowing *before* changing anything.

Keep the two straight: the Sessions panel *discovers* Claude Code sessions you
started yourself and can only point at them; the terminal dock *owns* the ones it
started. `ClaudeSession` is the former, `OpenTerminal` the latter.

The Sessions panel shows both, as two lists, because they support different
actions — discovered ones can only be focused, owned ones can be reattached and
ended. `PitwallTerminalSession` is the owned kind *as the panel sees it*: read
straight from `tmux list-sessions`, not from the process scan, so a session whose
Claude has exited still lists and can still be cleaned up.

**Ending a session is the only thing in this app that destroys something.** It is
not the same as the dock's `×`, which merely detaches. Both README and the
security summary say so; keep them saying it.

**Start Work is the only thing that writes upstream.** Creating is not
destroying, but it is still visible to other people — a branch, a PR and a
Linear status change all have an audience. Anything new that mutates GitHub or
Linear belongs behind a deliberate button like this one, never as a side effect
of a panel refreshing.

## Layout, and where to make changes

```text
src/lib/         pure logic — no network, no React. Fully unit-tested.
src/app/api/*/   thin route handlers: read env + config, call upstream, reshape.
src/hooks/       client behaviour that is neither markup nor pure — fetches, sockets.
src/components/  markup only. Logic belongs in lib/view.ts or a hook.
term-server/     the terminal sidecar. Wiring only — its logic is in lib/terminal.ts.
```

Behaviour changes almost always belong in `src/lib/`, with the test beside them.
Routes should stay thin enough that their tests are about *wiring*, not maths.

## The two config files behave differently

| File | Contents | Reload |
|---|---|---|
| `.env.local` | `GITHUB_TOKEN`, `LINEAR_API_KEY` | **Server restart required** — Next reads it once at startup |
| `config.json` | repos, Linear team key, status names, `wipLabel`, `terminals` | Hot — re-read on every request |

One exception to "hot": `terminals.enabled` reaches the browser through the page
server component, so toggling it needs a page reload, and `repos[].localPath`
likewise. The sidecar itself re-reads `config.json` per connection.

Both are gitignored with committed `.example` counterparts. Never commit either.
Adding a setting means updating `config.example.json`, `validateConfig`, and the
README reference table.

## Dependencies

**Do not run `npm audit fix`.** In this repo it proposes downgrading `next` from
16 to `9.3.3` and `eslint-config-next` to `12.0.4`, because its resolver falls
back to the last release predating each advisory. Run once, it took findings from
11 to 17.

Upgrade forward instead: `npm outdated`, then `npm install <pkg>@<version>`, then
re-audit and run the full gate.

`npm audit --omit=dev` reports **0 vulnerabilities**. Keep it there. Plain
`npm audit` also reports one dev-tooling advisory with no fix this repo can take,
and it is the only accepted finding - anything else is new:

- `braces` [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
  has no patched release of `braces` itself. It arrives only through
  `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` →
  `micromatch`; each package on that path is reported separately, which is why
  one advisory shows up as several highs. `npm audit` lists a "fix" for it: a
  major downgrade of `eslint-config-next` (to 14.2.35 when written), the same
  trap as above. Don't take it. It is a
  denial-of-service bug reachable only by handing lint a hostile glob pattern.

Tailwind is on v4, which dropped the `chokidar`, `micromatch` and
`postcss-selector-parser` paths v3 carried.

**Tailwind 4 renders the same as v3 did** on both tabs as they normally load
(screenshot diff, zero pixels); hover, focus, disabled, loading, error and the
terminal dock were not compared. The overrides that keep it that way live at the
top of `globals.css`, each with its reason. Don't remove one without re-diffing
screenshots of both tabs. `src/tailwindClasses.test.ts` fails on a bare
`transition`.

Theme colours and fonts live in the `@theme` block in `globals.css`; there is no
`tailwind.config.ts` any more. `rounded` in v3 is `rounded-sm` in v4, and
`outline-none` is `outline-hidden` - write the v4 names. Use `transition-ui`
rather than `transition`; `globals.css` says why.

`package.json` carries three `overrides` (`postcss`, `sharp`, `minimatch`) because
`next` and eslint pin vulnerable versions internally with no forward fix of their
own. Verify any change to them with a real build and boot, not just `npm audit`.
A vulnerable leaf whose patched version is already inside its consumer's range
needs no override, only `npm update <pkg>` to move the lockfile.

The `sharp` override's floor, `0.35.5`, is the release that patched a librsvg
CVE while `next` still accepted `0.35.4`. It can go once `next`'s own range
starts at `0.35.5` or later.

The lockfile is written by npm 11. npm 10 strips the `libc` constraints on the
Linux builds of `next`'s SWC binary and `sharp`, so a lockfile touched with npm
10 shows a large unexplained diff and installs both glibc and musl binaries on
Linux. Check `npm -v` before committing it.

The `minimatch` override is load-bearing: it is what keeps `brace-expansion` on
`5.0.8` or later, the first patched release. Override the **consumer**, never the leaf — forcing
`brace-expansion@5` directly throws `expand is not a function` on every lint run,
because `minimatch@3` calls it as a function.

A clean `eslint .` can also mean "matched no files", so after changing this
override, check for a false green rather than trusting the exit code. Three
checks: eslint still walks the whole tree (38 files when this was written, more
now), it still reports a deliberately planted `no-unused-vars`, and it still
honours `ignores` (a file under `.next/` stays skipped, which exercises
`@eslint/config-array`'s own minimatch path).

## Upstream API gotchas

These have each caused a real bug:

- **Linear's `scopeHistory` / `completedScopeHistory` are daily snapshots.** For
  the cycle in progress they lag real time, so the active cycle's team points are
  summed live instead. Closed cycles keep the snapshots deliberately — Linear
  rolls unfinished issues into the next cycle, so a live query on a closed cycle
  sees only completed work and would report ~100%.
- **There is no per-user historical scope.** So a closed cycle's personal
  denominator is unknowable; `hasMeaningfulPersonalTotal` exists to say so.
- **250 is Linear's max page size, and `hasNextPage` must be followed.** Two
  silent-undercount bugs came from ignoring it. `fetchLiveCyclePoints` and
  `fetchMyCycleIssues` show the pattern.
- **Linear has a 10k query-complexity ceiling.** Batching several cycles into one
  issues connection blows the page cap and truncates silently; keep them separate.
- **A GitHub `search` connection has no `totalCount` — it's `issueCount`.** Asking
  for `totalCount` is a hard GraphQL error, and one bad field fails the *whole*
  query, so it took the entire GitHub panel down. Stubbed fetches returned it
  happily; only the live API refused. Hit `localhost:3737/api/github` after
  touching a query.
- **`statusCheckRollup.state` rolls a *cancelled* check up as `FAILURE`.** Same
  value a broken build gets, so a run superseded by a newer push badged red with
  nothing to fix — the common case, since concurrency groups cancel constantly.
  `toCIState` downgrades to our own `CANCELLED` only when the evidence positively
  explains the red. Skipped and neutral runs never needed this: GitHub already
  rolls those up as `SUCCESS` (verified live, not assumed).
- **One commit carries several check suites, and the rollup counts span all of
  them.** A superseded run stays attached with its jobs' conclusions intact, so
  `contexts.checkRunCountsByState` tallies a job that failed in a dead run
  exactly like one failing now — and the red outlives its cause. One PR sat on
  `checks failed` with every job green: the `wip` label went on, the WIP gate ran
  to completion and failed, the label came off and everything re-ran clean.
  Another was the identical situation but badged `checks cancelled`, purely
  because its gate was killed 6 seconds in and never reached a verdict. So
  `toCIState` takes the suite conclusions as a *third* argument and prefers them:
  they say which run a verdict belongs to, where the counts only say how many
  there were. Two things keep it honest — failing **commit statuses** are checked
  first, since those belong to no suite, and a suite page short of `totalCount`
  is refused outright rather than read as "nothing failed".
- **`UNSTABLE` does not mean a check failed.** It's "mergeable, but not
  everything came back green", which also covers still-running and no-verdict.
  `mergeReadiness` reaches that branch only when the rollup *isn't* red, so the
  one thing it could never mean was the thing it used to say.
- **A merge queue is invisible to `mergeStateStatus`.** That enum has no queue
  member, so a queued PR reports `CLEAN` and badged green "ready to merge" on a
  PR whose merge button GitHub had already replaced. The
  state is on `isInMergeQueue` and `mergeQueueEntry`, and membership decides -
  GitHub returns a null entry with membership true. The queue branch in
  `mergeReadiness` sits above the `ciState` reds because the queue re-runs
  checks on a `gh-readonly-queue` branch against a different commit. Nothing
  here is per-repo: a repo without a queue simply reports no entry, so turning
  one on needs no change here.
- **Both PR searches are scoped to `config.json`'s repos, and that scope lives in
  two places on purpose.** `repo:` qualifiers do the real work — filtering only
  after the fact would let unrelated PRs eat the 50-node page — but an empty
  `repos` list produces an empty qualifier string, which is an *unrestricted*
  search rather than an empty one. `configuredRepoFilter` in the route is what
  makes that case show nothing instead of everything. Don't remove either half.
  GraphQL's search has no 256-character query cap (that's the REST API);
  17 `repo:` qualifiers at ~550 characters were verified live.
- **`issueCount` describes the search, not the list.** It's the review queue's
  "N of M" total, so it's only usable while the search did all the scoping — once
  the route's repo filter drops a node, the count includes rows we aren't showing
  plus rows past the page cap we can't inspect, and the list length is the only
  honest total.
- **`mergeStateStatus` is on `myOpenPRs` only, but not for the reason this note
  used to give.** The scoping is right: that panel is the only one rendering a
  merge verdict, so the review queue has no use for the field. The old reason -
  that GitHub computes it only for actors with push access, and a field-level
  denial would fail the whole query - **did not reproduce** on 2026-09-17:
  `facebook/react` at `viewerPermission: READ` returned
  `mergeStateStatus: "DIRTY"` without complaint. Field-level denial killing a
  whole query is still real, it is how the `totalCount` bug took the panel down;
  what is unproven is that this particular field is restricted. Don't widen the
  scope on the strength of one public-repo sample either - just don't cite a
  permission rule that hasn't been observed.
- **GitHub kills a GraphQL query at ~10 seconds and answers with nginx's 502.**
  Not a GraphQL error, so there is no message saying why - just an HTML error
  page, which reads exactly like rate limiting and isn't (measured: 4,420 of
  5,000 points left while it was failing every single time). Top-level aliases
  resolve *serially*, so a query's cost is the sum of its parts: the 18 per-repo
  approved searches were 6.3s at ~350ms each, the two PR searches ~2.6s apiece,
  the repo blocks 1.1s - 12.6s in one query, 502 on every refresh. `/api/github`
  therefore sends `buildGitHubQueries` as several parallel requests
  (`fetchGitHubData` merges them by top-level alias), which measured 2.4-3.1s
  end to end. The whole panel costs 8 rate-limit points a refresh, so budget is
  not the constraint - wall time inside one query is. Adding a heavy field means
  checking which query it lands in, and merging two of them back together brings
  the 502 straight back.
- **`fetchGitHubGraphQL` retries once, and only a *fast* failure.** A 502/503/504
  or a rejected connection answered in under 8s gets one more go 500ms later;
  anything slower is thrown straight through. That split is the point: the
  ceiling above arrives as an ordinary 502, and retrying a query that is too
  heavy can only double how long the panel takes to admit it is broken. Our own
  request timeout lands in the same branch and needs no special case, since it
  can only fire well past 8s. Retries `console.warn` to the dev server, because
  a silent one shows up as a request half a second slower and nothing else -
  and that log is how the 502s got diagnosed in the first place.
- **The server's retry budget and the browser's abort are one constraint.**
  `lib/timeouts.ts` holds both, and `WORST_CASE_REQUEST_MS` (the whole retry
  sequence, not one attempt) is checked against `serverWorstCaseFitsClient` by a
  test. They were a literal in `Dashboard.tsx` and a literal in `github.ts` with
  a comment between them, and the gap closed to 1.5s unnoticed - at which point
  the panel swaps the GitHub error for a bare `TimeoutError` and the reason it
  failed is gone.
- **GitHub caps `vulnerabilityAlerts` at 100 per page.** `totalCount` stays exact,
  the severity split doesn't. Don't present the split as complete.
- **Dependabot alerts need write/admin on the repo.** Repos you can't read report
  zeros rather than erroring, so a sparse Security panel may be permissions.

## Start Work, if you touch it

`lib/startWork.ts` (the rules), `lib/githubWrite.ts` and `lib/linearWrite.ts`
(the calls), `/api/start-work` (the order). Read the refusal in
`assignmentRefusal` first.

- **A ticket assigned to someone else is refused before any write.** The cost is
  asymmetric: running it twice on your own ticket is a no-op, but one transposed
  digit on a colleague's pushes a branch and opens a PR, and nothing in this app
  deletes either. A ticket already assigned to *you* proceeds — that's picking up
  your own work.
- **The PR title is `[ENG-1234] Subject`.** Brackets are the one form that
  links with no context: `ticketIdsFromPR` reads a bracketed id with any key.
  A bare `ENG-1234: Subject` links too, but only when `ENG` is a known team key
  (the workspace's teams, from Linear), because bare capitals-dash-digits alone
  would make "Fix HTTP-2 handling" a ticket. Brackets keep Start Work's PRs
  linked before Linear has answered. `stripTicketPrefix` takes the prefix back
  off for display, and tests assert the round trip, including after truncation.
- **The commit has to be empty, and empty means reusing the parent's tree.**
  GitHub refuses a PR whose head is its base ("No commits between…"), so the
  branch needs exactly one commit that changes nothing. Verified live: posting
  `{tree: <parent's tree>, parents: [<parent>]}` gives `ahead_by: 1` with zero
  files changed.
- **REST, not GraphQL, and deliberately.** `createCommitOnBranch` needs a branch
  that already exists and a file-changes payload; the git-database endpoints do
  the whole job in two posts. This is the only part of the app on REST.
- **The branch name comes from Linear's `branchName`,** which Linear generates
  per viewer and already prefixes with your name. Don't compose one — matching
  Linear's is what makes its GitHub integration link the PR without being asked.
- **Nothing here needs a local clone.** The sidecar already fetches `origin` and
  builds a tracking worktree for a remote-only branch, so the terminal button
  works on a PR made this way — and repos with no `localPath` can still use
  Start Work.
- **Rerunning is the normal case, so every step checks first.** An open PR on the
  branch short-circuits the whole GitHub half; an existing branch is reused
  rather than recreated. The response says `Found` rather than `Opened` so a
  second run can't read as a second PR.
- **Status moves forward only.** `planIssueUpdate` moves a ticket out of
  triage/backlog/unstarted and never out of `started` or `completed` — "start
  work" on something In Review would otherwise drag it backwards on the board.
- **GitHub first, Linear second.** A Linear failure after the PR exists is a note
  on a successful response, not an error: the PR is the artefact worth keeping
  and rerunning finishes the job. Reverse the order and a GitHub failure leaves
  a ticket assigned and moved with nothing to show for it.
- **`notes` is not an error list.** Every entry is something the user asked for
  that didn't need doing. Collapsing them into `error` would make the ordinary
  second run look broken.

## Local terminal state (the Sessions panel)

Each of these cost real debugging:

- **`tell application "iTerm2"` launches iTerm2 if it isn't running.** A dashboard
  poll would start a terminal for you. Guard with `if not (application "iTerm2"
  is running) then return ""`, which doesn't.
- **iTerm2 numbers windows by z-order.** Indices shifted between two calls
  seconds apart, so they are useless as stored identifiers — storing "window 1,
  tab 1" and focusing it later reliably selects the wrong terminal. The tty is
  the only stable handle; focusing re-searches by it at click time.
- **`ps` says `ttys001`, iTerm2 says `/dev/ttys001`.** Everything joins on the
  tty, so both spellings go through `normalizeTty` first.
- **`lsof` ignores `-p` here and dumps every process anyway.** So it's called
  once and the output is indexed by pid, which is both cheaper and the only thing
  that works. The `p<pid>` / `fcwd` / `n<path>` grouping is what makes that safe.
- **Claude Code's terminal title is the activity signal.** `✳ Claude Code` when
  idle, a braille spinner frame plus the task name when mid-turn. Keep the raw
  title around — cleaning it before testing for the spinner strips the very thing
  being detected, which is exactly the bug that shipped `isWorking: false` for a
  session that was visibly working. The UI only ever badges `working`, never
  "idle", so a format change fails quiet.
- **Automation permission belongs to the launching app, and `osascript` returns
  empty rather than erroring when it's refused.** So a denied permission looks
  identical to "no sessions" — the route detects all-unfocusable and says so.
- **Claude Code desktop can't be detected.** Its sessions have no controlling
  terminal and aren't per-session OS processes. Don't re-litigate: there is also
  nothing to focus, so a row for one could only be a dead end.

The tty from a focus request is allow-listed to `/dev/ttysN` and passed to
`osascript` as a **run argument**, never interpolated into script text. Keep it
that way; the tests assert both.
## Terminals, if you touch them

The README's Per-PR terminals section says what they do. What bit us building it:

- **node-pty's `spawn-helper` ships without its executable bit.** npm drops the
  mode when extracting the prebuild, and the only symptom is a bare
  `posix_spawnp failed.` with no mention of permissions. `scripts/fix-node-pty-permissions.mjs`
  runs on `postinstall` to fix it. Don't delete it — a fresh clone hits this.
- **tmux session names can't contain `.` or `:`.** It parses those as
  window/pane addresses. `sanitizeForTmux` exists for that, and the names must
  stay *derived* — a stored name would mean a restart silently starts a second
  session instead of reattaching.
- **`tmux new-session` takes its command as one re-parsed string,** not an argv.
  Passing separate words gets them re-split on spaces, so `shellQuote` wraps
  them. Don't "simplify" it to `...args.command`.
- **The client is only ever allowed to send identifiers.** `{repo, prNumber,
  branch}` in, everything else derived from config in the sidecar. If you find
  yourself wanting to pass a path or a command from the browser, don't — that's
  the whole security boundary.
- **`git worktree add` fails if the branch is checked out elsewhere,** so
  `findWorktreeForBranch` looks first and reuses. This is why opening a terminal
  on the branch your main clone is already on lands you in the main clone.
- **It also fails if the *path* exists at all,** which the branch check doesn't
  catch: `worktreeDirName` truncates the branch to 60 characters, and anything
  running in the terminal can switch branches inside the directory — so the path
  we'd create is routinely already a worktree holding a branch we don't
  recognise. `findWorktreeAtPath` finds it and it gets reused, with
  `worktreeCheckoutArgv` switching it over. Two things this depends on: git
  reports worktree paths through **realpath**, so the target path is
  canonicalised before comparing or a symlinked root silently never matches
  (this cost a probe run); and the checkout is skipped outright when the
  worktree is dirty, rather than trusted to `git checkout`'s own refusal —
  that only fires when the dirty file collides with the target branch, so a
  dirty file the branch doesn't touch would otherwise switch branches with
  the uncommitted changes silently carried along (verified against git 2.50.1).
  The session opens in the directory either way, since that uncommitted work
  is usually why you wanted a terminal. `--force` is no help here: it covers a
  *missing* worktree's path, not an occupied one (verified).
- **`worktree prune` runs before the list, not between it and the add.** A stale
  record — directory deleted, admin data still there — would otherwise be read
  as a worktree to reuse, and the checkout would run in a directory that isn't
  there.
- **Turbopack warns on `path.join(process.cwd(), SOME_IMPORTED_CONST)`** in a
  route's module graph — it can't fold a constant from another module, decides
  the whole project is being traced, and warns on every build. `terminalRuntime.ts`
  uses the filename literal for that reason, with a test pinning it to the
  constant.
- **Panes are hidden, never unmounted.** Unmounting closes the socket, and tmux
  replays only the visible screen on reattach — so a background PR's output would
  be gone from the scrollback.
- **`kill-session -t name` is a prefix match.** tmux tries exact, then prefix,
  then fnmatch — so killing `pitwall_a_1` can take out `pitwall_a_12`. Every
  target is written `=name`. `tmuxKillSessionArgv` exists so no route builds one
  by hand, and a test pins the `=`.
- **`kill-session` returns before the process is gone.** It returns once tmux has
  forgotten the session; the process inside is only then being SIGHUPped, ~240ms
  for a trivial one. In that gap tmux no longer claims the tty, so the Sessions
  panel stops attributing it to a hosted terminal and the dying process surfaces
  in the *discovered* list as an inert `no window` row — the killed session
  appears to jump lists. Since a kill triggers an immediate refetch, that gap is
  exactly what you see. The route reads the pane ttys *before* killing and waits
  for them to clear. Don't drop that wait.
- **A tmux session name is matched forwards, never parsed.** `sanitizeForTmux`
  maps both `a/b` and `a.b` to `a-b`, so reversing a name guesses. Resolution
  computes `tmuxSessionName` for each configured repo and compares — which also
  means a session whose repo has left `config.json` simply doesn't list, rather
  than half-resolving into a row offering actions it can't perform.

## Removing worktrees, if you touch it

`lib/terminalWorktrees.ts` and the removal half of `/api/terminal/kill` are the
only things in the app that delete files. Read `isManagedWorktree` first.

- **Opening a terminal does not always create a worktree.** `findWorktreeForBranch`
  reuses whatever already holds the branch — routinely your main clone or a
  hand-made `.claude/worktrees/*`. Those are *borrowed*, never owned: ending
  their session is fine, removing their directory is not. On a real dashboard
  this was 3 of 6 rows, so it is the common case, not the edge.
- **"Under the worktree root" is one path segment, not a prefix.**
  `startsWith(root)` accepts nested paths and anything a symlink points at. The
  check is `path.relative` plus no separator, with tests for the managed dir
  itself and for `pr-1-x/sub`.
- **Never delete the branch.** Removing a worktree leaves refs alone, which is
  what makes the feature recoverable — worst case you re-open the terminal. A
  `git branch -d` here would make it destructive in a way nothing warns about.
- **`localPath` is hand-written and usually starts with `~`.** `git -C` gets no
  shell, and discovery runs through `tryCommand`, so an unexpanded tilde fails
  *silently*: every repo reports no worktrees and the panel cheerfully says there
  is nothing to remove. This shipped once. Route fixtures use `~/Dev/billing-app`
  deliberately; an absolute path hides it.
- **The pane's cwd is for display only.** `pane_current_path` is what lets a row
  say "reused · ~/Dev/forms-app", but a pane can be `cd`'d anywhere — removal
  always re-resolves the path from `git worktree list`. Don't wire the cwd into
  the delete path.
- **A row is one PR, not one tmux session.** The two halves outlive each other,
  so `terminalRows` unions them; a worktree whose session ended is still a row.
  Drop that and it becomes a leftover nothing in the UI can reach, which is the
  hole this closed.
- **An unreachable GitHub must not read as "PR closed".** `terminalRows` takes
  `prs: MyPR[] | null` and sets `prKnown`, because `pr closed` is the row's main
  hint that deleting is safe — a failed fetch arriving as `[]` labelled every
  live PR closed.

## Testing

`vitest`, node environment, no DOM stack — and deliberately so: rendering
presentational markup isn't worth `@testing-library/react` plus jsdom here.
Extract logic to `lib/view.ts` and test it there instead.

Route tests mock `readConfig` (it reads the filesystem) and stub `fetch`.
`src/app/api/linear/route.test.ts` mocks `lib/linear` via `importOriginal` so the
real query constants stay in play.

Two habits that have repeatedly paid off:

- **Mutation-check new tests.** Break the code deliberately and confirm the test
  fails. Several tests here passed while asserting nothing until checked this way.
- **`vitest` passing is not a green build.** It strips types; `tsc` has caught
  type errors in test files that vitest ran happily. Run `npm run typecheck`.

Full gate before pushing: `npm run typecheck && npm test && npm run lint && npm run build`.

## Workflow

Branch off `main` and open a PR — `main` takes changes only through merged PRs,
and CI (typecheck, tests, lint, build) must be green. **A maintainer merges; open the
PR and stop.**

This repo is public, and so is everything attached to it. Commit messages, PR
descriptions, code comments and test fixtures must not name private repos,
customers, colleagues or internal tickets. Fixtures use made-up names
(`Northwind/billing-app`, `Acme/alpha`, `alexdoe`).

## Deferred, with reasons

Don't re-litigate these without new information:

- **Single-tenant by design.** One token pair = one person's view, so everyone
  runs their own copy locally. Settled — not a gap, and the reason not to
  containerise or host it. Terminals make this *stricter*, not looser: port 3738
  attaches to a shell, so exposing either port is now a real hazard rather than
  an untidiness. Both bind `127.0.0.1`: the sidecar in `term-server/index.ts`,
  the dashboard through `-H 127.0.0.1` in `package.json`. Next listens on every
  interface without it, and the same-origin checks on the write routes only stop
  browsers, so don't drop the flag.
- **Binding to 127.0.0.1 keeps out other machines, not other websites.** A page
  can point its own hostname at 127.0.0.1 (DNS rebinding) and the browser then
  sends it to the dashboard with `Host: evil.example:3737` and a matching
  `Origin`, so the old "Origin equals Host" check passed and `/api/github`,
  `/api/terminal` (the sidecar token) and every write route answered it.
  `src/proxy.ts` now 403s any request whose Host isn't a local name, and
  `isSameOrigin` requires a local Host too. Verified against a real build, not
  just the tests. The sidecar was never exposed: `isAllowedOrigin` allow-lists
  the app's origin by name.

## Open ideas, not started

- ~~**Make dock terminals focusable from the Sessions panel.**~~ Done.
  Rather than making the inert row live, the panel now shows two lists:
  discovered sessions (focus) and hosted terminals (reattach, end). A hosted
  terminal's tty is subtracted from the discovered list so it appears
  once, under the half that can act on it. One limit worth keeping in mind:
  reattaching needs a branch and title, which live on the PR and not in tmux, so
  a session whose PR has merged can be ended but not reopened — `terminalRows`
  pairs them and the row says which.
- Component render tests, if the panels ever gain real interactivity — the
  no-DOM-stack decision was about presentational markup, not a permanent ban.
- The Velocity panel could show your share of team output on closed cycles
  (`69 of 129 team pts`) instead of a bare figure. Rejected once because it
  silently changes what the denominator means between cards, but it's arguable.
