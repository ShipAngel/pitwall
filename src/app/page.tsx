import { readConfig } from "@/lib/config";
import { terminalsEnabled } from "@/lib/terminal";
import Dashboard from "@/components/Dashboard";
import { DEFAULT_HOTSPOT_THRESHOLD } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function Page() {
  // A missing or invalid config.json is the likeliest first-run failure, and
  // unhandled here it surfaced as Next's raw error overlay in dev and a bare
  // "Application error" in a production build. readConfig's messages already say
  // what to fix, so the page shows one of them instead.
  let config;
  try {
    config = await readConfig();
  } catch (err) {
    return <ConfigError message={err instanceof Error ? err.message : String(err)} />;
  }
  return (
    <Dashboard
      refreshIntervalSeconds={config.refreshIntervalSeconds}
      repos={config.repos}
      teamKey={config.linear.teamKey}
      hotspotThreshold={config.hotspotThreshold ?? DEFAULT_HOTSPOT_THRESHOLD}
      terminalsEnabled={terminalsEnabled(config)}
    />
  );
}

function ConfigError({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-lg font-semibold">Pitwall can&apos;t start yet</h1>
      <p className="mt-4 rounded border border-line bg-bg-panel p-4 font-mono text-sm text-accent-red">
        {message}
      </p>
      <p className="mt-4 text-sm text-text-muted">
        Fix config.json and refresh. It&apos;s re-read on every request, so no restart is
        needed. See the README&apos;s Configuration section for every setting.
      </p>
    </main>
  );
}
