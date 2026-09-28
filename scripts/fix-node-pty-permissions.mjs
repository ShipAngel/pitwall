/**
 * Restores the executable bit on node-pty's `spawn-helper`.
 *
 * node-pty ships prebuilt binaries, and npm's extraction drops the mode bit on
 * this one. Without it every pty spawn fails with a bare "posix_spawnp failed."
 * — no mention of permissions — so this runs on postinstall rather than leaving
 * a fresh clone to debug it.
 *
 * Silent when there is nothing to do: node-pty may legitimately be absent, and a
 * postinstall script must not fail the install.
 */
import { chmod, readdir, stat } from "node:fs/promises";
import path from "node:path";

const PREBUILDS = path.join(process.cwd(), "node_modules", "node-pty", "prebuilds");

async function main() {
  let dirs;
  try {
    dirs = await readdir(PREBUILDS);
  } catch {
    return; // node-pty not installed.
  }

  for (const dir of dirs) {
    const helper = path.join(PREBUILDS, dir, "spawn-helper");
    try {
      const { mode } = await stat(helper);
      if (mode & 0o111) continue; // Already executable.
      await chmod(helper, 0o755);
      process.stdout.write(`node-pty: made ${dir}/spawn-helper executable\n`);
    } catch {
      // No helper for this platform (Windows), or not ours to change.
    }
  }
}

await main();
