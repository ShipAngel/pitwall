#!/usr/bin/env bash
#
# start.sh — boot the Pitwall dev dashboard (Next.js, port 3737)
#
# Usage:
#   ./start.sh          Start the dev server (hot reload)
#   ./start.sh prod     Build and start the production server
#
set -euo pipefail

# Run from the directory this script lives in, regardless of where it's called from.
cd "$(dirname "$0")"

MODE="${1:-dev}"
PORT=3737
TERM_PORT=3738 # TERMINAL_PORT in src/lib/terminal.ts

# --- Node version check (package requires Node 20+) -------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is not installed. Install Node 20+ (see .nvmrc) and retry."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "✗ Node $(node --version) found, but Node 20+ is required."
  echo "  If you use nvm:  nvm use"
  exit 1
fi

# --- Already running? -------------------------------------------------------
# Checked before anything else, because the steps below act on a running copy's
# files: the dependency sync and the .next clear would pull them out from under
# it, and only then would the boot fail on the busy port. An old copy left
# running in another terminal is the usual cause. The terminal server's port is
# checked only when terminals are turned on, so an unrelated tool on 3738 can't
# block a dashboard that never uses it. No config.json yet means they're off.
#
# A connect, not a trial bind: on macOS binding 127.0.0.1 succeeds even while
# another server holds the port on all interfaces or on ::1. Prints each port
# something answers on.
if ! BUSY_PORTS="$(node -e "
  const net = require('net');
  let terminals = false;
  try { terminals = !!require('./config.json').terminals?.enabled; } catch {}
  const ports = terminals ? [${PORT}, ${TERM_PORT}] : [${PORT}];
  const answers = (port, host) => new Promise((resolve) => {
    const sock = net.connect(port, host)
      .once('connect', () => { sock.destroy(); resolve(true); })
      .once('error', () => resolve(false));
    sock.setTimeout(1000, () => sock.destroy(new Error('timeout')));
  });
  Promise.all(ports.map(async (p) =>
    (await answers(p, '127.0.0.1')) || (await answers(p, '::1')) ? p : null,
  )).then((r) => process.stdout.write(r.filter(Boolean).join(' and ')));
")"; then
  echo "⚠  Couldn't check whether Pitwall is already running."
  BUSY_PORTS=""
fi
if [ -n "$BUSY_PORTS" ]; then
  echo "✗ Something is already listening on ${BUSY_PORTS} - Pitwall may already be running."
  echo "  Stop the other copy (Ctrl-C in its terminal), or find it with:"
  echo "    lsof -iTCP:${PORT} -iTCP:${TERM_PORT} -sTCP:LISTEN"
  exit 1
fi

# --- Config files -----------------------------------------------------------
if [ ! -f .env.local ]; then
  echo "→ .env.local missing — creating it from the example."
  cp .env.local.example .env.local
fi

if [ ! -f config.json ]; then
  echo "→ config.json missing — creating it from the example."
  cp config.example.json config.json
fi

# Only the settings with no default are named (repos, linear.teamKey): the ones
# you have to fill in yourself. Every other setting works when absent, so a
# commit that adds one to config.example.json changes nothing for you, and
# warning about it would read as something broken. Copying them into your
# config.json was the other option, but that would pin today's defaults there,
# and a later change to a default would never reach you.
#
# Keep this list in step with what validateConfig requires.
if ! MISSING_KEYS="$(node -e "
  const mine = require('./config.json');
  const missing = [];
  if (!Object.hasOwn(mine, 'repos')) missing.push('repos');
  if (!mine.linear?.teamKey) missing.push('linear.teamKey');
  process.stdout.write(missing.join(', '));
" 2>/dev/null)"; then
  # Reported rather than swallowed: a failed comparison and a clean one both
  # leave MISSING_KEYS empty, and a silent all-clear from a check that never ran
  # is worse than no check at all. Still non-fatal — this shouldn't stop a boot.
  echo "⚠  Couldn't read config.json - is it valid JSON?"
  MISSING_KEYS=""
fi
if [ -n "$MISSING_KEYS" ]; then
  echo "⚠  config.json is missing: ${MISSING_KEYS}"
  echo "   These have no default. Copy them from config.example.json and fill in"
  echo "   your own values; the dashboard shows an error until you do."
fi

# The mirror image: a commit that *removes* a setting can't touch your gitignored
# config.json, so the dead key sits there forever with nothing to say so.
# validateConfig deliberately ignores extras rather than throwing — it runs on
# every request, and taking the dashboard down over a stale line would be a worse
# outcome than the stale line. So it is named here instead, once, at boot.
#
# One level into objects, unlike the check above. A key the example lacks is
# either dead or a typo, and both are worth naming; that isn't true in the other
# direction, where an absent key is usually just a default you were happy with.
# Arrays are skipped — repos entries legitimately differ from the example's.
if ! DEAD_KEYS="$(node -e "
  const example = require('./config.example.json');
  const mine = require('./config.json');
  const dead = [];
  const walk = (ex, got, prefix) => {
    for (const [k, v] of Object.entries(got)) {
      const path = prefix ? prefix + '.' + k : k;
      // hasOwn, not \`in\`: a key literally named \"constructor\" or \"toString\"
      // resolves through the prototype and would never be reported.
      if (!Object.hasOwn(ex, k)) { dead.push(path); continue; }
      const both = (o) => o && typeof o === 'object' && !Array.isArray(o);
      if (both(v) && both(ex[k])) walk(ex[k], v, path);
    }
  };
  walk(example, mine, '');
  process.stdout.write(dead.join(', '));
" 2>/dev/null)"; then
  echo "⚠  Couldn't check config.json for unused keys — is it valid JSON?"
  DEAD_KEYS=""
fi
if [ -n "$DEAD_KEYS" ]; then
  echo "⚠  config.json has keys the app no longer reads: ${DEAD_KEYS}"
  echo "   Removed by a newer commit, or a typo. Either way they do nothing —"
  echo "   safe to delete. Not an error; the dashboard runs fine as-is."
fi

# Warn (don't block) if the API tokens look empty.
if ! grep -q '^GITHUB_TOKEN=.\+' .env.local || ! grep -q '^LINEAR_API_KEY=.\+' .env.local; then
  echo "⚠  GITHUB_TOKEN and/or LINEAR_API_KEY are empty in .env.local."
  echo "   The dashboard will load but show errors until you fill them in:"
  echo "   • GitHub token: https://github.com/settings/tokens (repo + read:user)"
  echo "   • Linear key:   https://linear.app/settings/account/security"
fi

# --- Dependencies -----------------------------------------------------------
# Unconditional, not just when node_modules is missing. Pulling a branch that
# adds a dependency leaves the existing node_modules in place but stale, and the
# only symptom is a "Module not found" build error once the page loads — which
# reads as broken code rather than a missing install. A no-op install is ~0.4s,
# far cheaper than that failure mode.
#
# --no-save is load-bearing: it installs what the lockfile says and never writes
# it back. Without it, booting the dashboard rewrites package-lock.json to
# whatever your local npm emits, so the working tree is dirty every single time.
# The concrete case: Dependabot runs npm 11, which records a "libc" field on the
# 30 optional linux/win binary packages (sharp, @next/swc, @rolldown,
# lightningcss); .nvmrc pins Node 20, whose npm 10 drops it. Boot the app and
# those 90 lines vanish from the lockfile, with nothing to say the app did it.
# Installing from the lockfile is the whole job here anyway - a branch that adds
# a dependency brings its updated lockfile along with it.
#
# --no-audit because the report it prints is noise here, and harmful noise: it
# counts the one accepted dev-tooling advisory (see CLAUDE.md) as several highs
# and suggests `npm audit fix --force`, which downgrades eslint-config-next.
echo "→ Syncing dependencies (npm install)..."
npm install --no-save --no-fund --no-audit

# Next's .next cache can outlive a dependency change; see the script for why.
if ! node scripts/clear-stale-next-cache.mjs; then
  echo "⚠  Couldn't check whether .next needs clearing. If pages fail to build"
  echo "   with \"Cannot find module\", delete the .next folder and start again."
fi

# --- Terminals (optional) ---------------------------------------------------
# Only started when config.json opts in. The sidecar is a separate process
# because Next has nowhere to keep a long-lived socket; tmux is what makes the
# sessions outlive it.
TERMINALS_ON=0
if node -e "
  const c = require('./config.json');
  process.exit(c.terminals && c.terminals.enabled ? 0 : 1);
" 2>/dev/null; then
  TERMINALS_ON=1
  if ! command -v tmux >/dev/null 2>&1; then
    echo "⚠  Terminals are enabled in config.json but tmux is not installed."
    echo "   Sessions are tmux-backed so they survive restarts. Install it with:"
    echo "     brew install tmux"
    TERMINALS_ON=0
  fi
fi

TERM_PID=""
cleanup() {
  if [ -n "$TERM_PID" ]; then
    # SIGTERM only: the sidecar detaches its tmux clients and leaves the
    # sessions — and anything running in them — alive.
    kill "$TERM_PID" 2>/dev/null || true
    wait "$TERM_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ "$TERMINALS_ON" = "1" ]; then
  echo "▶ Starting terminal server on ws://127.0.0.1:${TERM_PORT}"
  npm run term &
  TERM_PID=$!
fi

# --- Launch -----------------------------------------------------------------
echo ""
echo "▶ Starting Pitwall on http://localhost:${PORT}  (mode: ${MODE})"
echo ""

if [ "$MODE" = "prod" ]; then
  npm run build
  npm start
else
  npm run dev
fi
