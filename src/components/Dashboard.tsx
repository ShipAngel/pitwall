"use client";

import { useState } from "react";
import useSWR from "swr";
import { useOpenTerminals } from "@/hooks/useOpenTerminals";
import { useTabSelection } from "@/hooks/useTabSelection";
import { tabIds, type TabId } from "@/lib/tabs";
import { terminalRows } from "@/lib/view";
import Tabs from "./Tabs";
import type {
  GitHubResponse,
  LinearResponse,
  RepoConfig,
  SecurityResponse,
  SessionsResponse,
} from "@/types";
import RefreshHeader from "./RefreshHeader";
import MySection from "./MySection";
import ReviewRequestsSection from "./ReviewRequestsSection";
import StartWorkCard from "./StartWorkCard";
import SessionsSection from "./SessionsSection";
import TeamSection from "./TeamSection";
import SecuritySection from "./SecuritySection";
import CyclePointsSection from "./CyclePointsSection";
import TerminalDock from "./TerminalDock";
import { CLIENT_FETCH_TIMEOUT_MS } from "@/lib/timeouts";

// SWR schedules the next poll only after this promise settles — a fetch that
// never resolves (e.g. severed mid-flight by system sleep) kills auto-refresh
// permanently, so the request must always time out. cache:"no-store" stops the
// browser serving a stale response for a poll that looks identical.
const fetcher = async (url: string) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error ?? `Request failed: ${res.status}`);
  }
  return json;
};

// Keep polling even in a background tab, and re-fetch when the network or tab
// wakes — so the dashboard stays live when left open, and recovers after sleep.
const swrOptions = {
  refreshWhenHidden: true,
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  keepPreviousData: true,
} as const;

/**
 * How often to re-read local terminal state. Short, because it costs a few
 * subprocesses rather than an API call, and because a "working" badge that lags
 * five minutes behind is worse than none — it would describe a turn that ended
 * long ago. Capped by the configured interval so a deliberately slow dashboard
 * stays slow.
 */
const SESSIONS_REFRESH_MS = 30_000;

type Props = {
  refreshIntervalSeconds: number;
  repos: RepoConfig[];
  teamKey: string;
  hotspotThreshold: number;
  terminalsEnabled: boolean;
};

export default function Dashboard({
  refreshIntervalSeconds,
  repos,
  teamKey,
  hotspotThreshold,
  terminalsEnabled,
}: Props) {
  const intervalMs = refreshIntervalSeconds * 1000;

  const { tab, selectTab } = useTabSelection();

  // One timestamp per source rather than one shared between them. The three
  // endpoints poll independently, so a single "last updated" let any one success
  // keep the header looking fresh while another source had been failing for
  // hours. freshness() reports the oldest of these.
  const [githubAt, setGithubAt] = useState<Date | null>(null);
  const [linearAt, setLinearAt] = useState<Date | null>(null);
  const [securityAt, setSecurityAt] = useState<Date | null>(null);
  const [sessionsAt, setSessionsAt] = useState<Date | null>(null);

  const gh = useSWR<GitHubResponse>("/api/github", fetcher, {
    refreshInterval: intervalMs,
    onSuccess: () => setGithubAt(new Date()),
    ...swrOptions,
  });
  const lin = useSWR<LinearResponse>("/api/linear", fetcher, {
    refreshInterval: intervalMs,
    onSuccess: () => setLinearAt(new Date()),
    ...swrOptions,
  });
  const sec = useSWR<SecurityResponse>("/api/security", fetcher, {
    refreshInterval: intervalMs,
    onSuccess: () => setSecurityAt(new Date()),
    ...swrOptions,
  });

  // Sessions come from local commands rather than a rate-limited API, and they
  // change on the timescale of a Claude turn — so this polls far more often than
  // the upstream panels, whose interval exists to stay inside API budgets.
  const sess = useSWR<SessionsResponse>("/api/sessions", fetcher, {
    refreshInterval: Math.min(intervalMs, SESSIONS_REFRESH_MS),
    onSuccess: () => setSessionsAt(new Date()),
    ...swrOptions,
  });

  const onRefresh = () => {
    gh.mutate();
    lin.mutate();
    sec.mutate();
    sess.mutate();
  };

  /*
   * Terminals Pitwall is *hosting*, which are not the `sess` sessions above:
   * those are Claude Code processes discovered in your own iTerm2 windows, these
   * are panes this page owns. Hence "openTerminals" rather than "sessions" —
   * both concepts live in this component and the shorter name belongs to
   * neither.
   *
   * The state lives above the dock so it survives anything that re-renders the
   * panels, and the entries are snapshots rather than references into SWR data:
   * a refresh replaces every MyPR object, and a pane keyed on one of those would
   * remount and drop its socket.
   */
  const {
    terminals: openTerminals,
    activeKey: activeTerminal,
    openTerminal,
    activateTerminal,
    closeTerminal,
  } = useOpenTerminals();

  // Not part of the dock's own state: the page needs it for bottom padding, and
  // the dock reports it upward rather than owning where it is used.
  const [dockHeight, setDockHeight] = useState(0);

  // isValidating (not isLoading) is true on every refetch, not just the first
  // load — so the button reflects manual refreshes and auto-refresh ticks too.
  // Sessions are excluded deliberately: at a 30s cadence they would strobe the
  // button roughly forever, and they aren't the fetch you're ever waiting on.
  const isRefreshing = gh.isValidating || lin.isValidating || sec.isValidating;

  return (
    <div
      // Wide by design: every panel here is a table or a row of cards, which
      // gain from horizontal room rather than losing to it — the old 6xl (72rem)
      // left half a landscape monitor empty while PR titles truncated. Still
      // capped, because the two-column grids would stretch absurdly on an
      // ultrawide, and `mx-auto` keeps it centred below the cap.
      className="mx-auto w-full max-w-[120rem] p-6"
      // The dock is fixed to the bottom, so the page needs room beneath its
      // content or the last rows sit permanently behind it.
      style={dockHeight > 0 ? { paddingBottom: dockHeight + 24 } : undefined}
    >
      <RefreshHeader
        linearName={lin.data?.viewer.name}
        githubLogin={gh.data?.viewer}
        loading={isRefreshing}
        sourceUpdates={[githubAt, linearAt, securityAt, sessionsAt]}
        onRefresh={onRefresh}
        intervalSeconds={refreshIntervalSeconds}
      />

      <Tabs active={tab} onChange={selectTab} />

      {/* Both panels stay mounted and hidden rather than unmounting, so
          `aria-controls` always points at something real and switching tabs
          doesn't throw away and rebuild the other half. Every source keeps
          polling either way — the hooks live here, above the tabs — so the
          header can't claim to be fresher than the tab you aren't looking at. */}
      {/* No section headings on this tab. "Local Code Sessions" and "My Work"
          were a row of vertical space each to say what the tab already says and
          the cards below already title — worth reclaiming on a portrait
          monitor. The Team tab keeps its headings, where they group several
          panels under genuinely different subjects. Sessions still comes first:
          it's the card you act *through* rather than read. */}
      <Panel id="cockpit" active={tab}>
        <div className="mt-6 grid gap-6">
          {/* Above Sessions and Start Work: these are PRs blocking someone else
              on you, which outranks both the local session state and your own
              PRs for attention. */}
          <ReviewRequestsSection
            github={gh.data}
            githubError={gh.error instanceof Error ? gh.error.message : undefined}
            linear={lin.data}
          />
          {/* Sessions and Start Work share a row because they are the two things
              you act *through* — the tables below are what you read, and they
              want the full width. Stacked, Start Work spent a permanent 120px on
              a form used a few times a day.

              The cards stretch to match rather than sitting at their natural
              heights: two boxes of different height beside each other read as a
              layout accident, and the shorter one gains usable room instead of
              trailing whitespace below it.

              `xl:` rather than `lg:` because two 470px columns at the smaller
              breakpoint would start truncating session titles. Measured at
              1470px: nothing overflows, and the tab loses 144px. */}
          <div className="grid gap-6 xl:grid-cols-2">
            <SessionsSection
              data={sess.data}
              error={sess.error instanceof Error ? sess.error.message : undefined}
              // `null`, not `[]`, when GitHub has given us nothing: an empty
              // list would mean "none of these PRs are open", which is a very
              // different claim from "we couldn't ask".
              terminals={terminalRows(
                sess.data?.terminals ?? [],
                sess.data?.worktrees ?? [],
                gh.data ? gh.data.myPRs : null,
              )}
              showTerminals={terminalsEnabled}
              activeTerminalKey={activeTerminal}
              onOpenTerminal={(row) => row.pr && openTerminal(row.pr)}
              // Ending a session takes its dock pane with it. Left open, the
              // pane sits on a dead terminal offering to reconnect to something
              // that no longer exists.
              onEnded={closeTerminal}
              onRefresh={sess.mutate}
            />
            {/* Still above My PRs in reading order, because what it creates
                lands there: the draft PR shows up in that table on the refetch
                this triggers, with its terminal button beside it. */}
            <StartWorkCard
              repos={repos}
              teamKey={teamKey}
              onStarted={() => {
                gh.mutate();
                lin.mutate();
              }}
            />
          </div>
          <MySection
            repos={repos}
            github={gh.data}
            githubError={gh.error instanceof Error ? gh.error.message : undefined}
            linear={lin.data}
            linearError={lin.error instanceof Error ? lin.error.message : undefined}
            onOpenTerminal={terminalsEnabled ? openTerminal : undefined}
          />
        </div>
      </Panel>

      {/* Headings dropped here too. "Team Pulse" is the tab, and "Security" and
          "Velocity" each sat above cards that already name themselves —
          Dependabot Alerts, Exposure, Cycle Points. */}
      <Panel id="teampulse" active={tab}>
        <div className="mt-6 grid gap-6">
          <TeamSection
            github={gh.data}
            githubError={gh.error instanceof Error ? gh.error.message : undefined}
            linear={lin.data}
            linearError={lin.error instanceof Error ? lin.error.message : undefined}
            teamKey={teamKey}
            hotspotThreshold={hotspotThreshold}
          />
          <SecuritySection
            security={sec.data}
            securityError={sec.error instanceof Error ? sec.error.message : undefined}
          />
          {/* Hidden once Linear says the team doesn't use cycles or doesn't
              estimate: the panel shows nothing but point totals, which would be
              empty or zero. Shown while loading, so it doesn't pop in. */}
          {lin.data?.cyclesEnabled !== false && lin.data?.estimatesEnabled !== false && (
            <CyclePointsSection
              linear={lin.data}
              linearError={lin.error instanceof Error ? lin.error.message : undefined}
            />
          )}
        </div>
      </Panel>

      {/* Outside both panels on purpose: a terminal you are working in shouldn't
          close because you glanced at Team Pulse. */}
      <TerminalDock
        terminals={openTerminals}
        activeKey={activeTerminal}
        onActivate={activateTerminal}
        onClose={closeTerminal}
        onHeightChange={setDockHeight}
      />
    </div>
  );
}

/** One tab's contents, present in the DOM but hidden unless it's the active one. */
function Panel({
  id,
  active,
  children,
}: {
  id: TabId;
  active: TabId;
  children: React.ReactNode;
}) {
  const ids = tabIds(id);
  return (
    <div
      id={ids.panel}
      role="tabpanel"
      aria-labelledby={ids.tab}
      hidden={id !== active}
      // The panel itself is focusable so that tabbing out of the tablist lands
      // in the content it selected, rather than skipping past it.
      tabIndex={id === active ? 0 : -1}
    >
      {children}
    </div>
  );
}
