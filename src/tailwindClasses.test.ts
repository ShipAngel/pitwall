import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Tailwind 4's `transition` also animates outline-color, so a keyboard focus
// ring fades in where v3 showed it at once. globals.css defines `transition-ui`
// with v3's property list instead, and nothing else would stop a plain
// `transition` creeping back: it is the name everyone reaches for.
const src = path.resolve(__dirname);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(full);
    return e.name.endsWith(".tsx") ? [full] : [];
  });
}

/** A bare `transition` class token: not `transition-ui`, `transition-colors` and so on. */
const BARE_TRANSITION = /(?<=^|[\s"'`{])transition(?=$|[\s"'`}])/m;

describe("Tailwind classes", () => {
  it("finds the components it is meant to scan", () => {
    expect(tsxFiles(src).length).toBeGreaterThan(10);
  });

  it("matches a bare `transition` and nothing longer", () => {
    expect(BARE_TRANSITION.test(`className="rounded transition hover:x"`)).toBe(true);
    expect(BARE_TRANSITION.test("className={`px-2 transition ${a}`}")).toBe(true);
    expect(BARE_TRANSITION.test(`className="transition-ui hover:x"`)).toBe(false);
    expect(BARE_TRANSITION.test(`className="transition-colors"`)).toBe(false);
  });

  it("uses `transition-ui`, never a bare `transition`", () => {
    const offenders = tsxFiles(src).filter((f) => BARE_TRANSITION.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(src, f))).toEqual([]);
  });
});
