// Clears Next's .next build cache on the first start after package-lock.json
// changes. Run by start.sh after the dependency sync.
//
// The cache can outlive a dependency change: after the move to Tailwind 4, a
// pull plus ./start.sh failed with "Cannot find module '@tailwindcss/postcss'"
// on every page load, with the package installed, until .next was deleted by
// hand. .next holds nothing but build output, so clearing it costs one slower
// first compile per update.
//
// The lockfile's hash is kept in node_modules, which is per-install and
// gitignored, so a fresh clone or a reinstall also starts from a clean cache.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const STAMP = "node_modules/.pitwall-lockfile-hash";

const hash = createHash("sha256")
  .update(readFileSync("package-lock.json"))
  .digest("hex");

let seen = "";
try {
  seen = readFileSync(STAMP, "utf8");
} catch {
  // No stamp yet: first start since install. Treated as a change.
}

if (seen !== hash) {
  if (existsSync(".next")) {
    rmSync(".next", { recursive: true, force: true });
    console.log(
      "→ Dependencies changed since the last start; cleared the .next build cache.",
    );
  }
  writeFileSync(STAMP, hash);
}
