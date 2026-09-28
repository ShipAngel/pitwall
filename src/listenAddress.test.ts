import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Next listens on every interface unless told otherwise, and the same-origin
// checks on the write routes only stop browsers - a script on the same network
// sets Origin and Host to whatever it likes. So the bind address is the guard,
// and it lives in two places no other test reads.
const root = path.resolve(__dirname, "..");

describe("listen address", () => {
  const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

  it.each(["dev", "start"])("npm run %s binds the dashboard to 127.0.0.1", (name) => {
    const args: string[] = scripts[name].split(/\s+/);
    expect(args[0]).toBe("next");
    // Exactly one hostname flag: Next takes the last of several, so a second
    // `--hostname 0.0.0.0` would win over ours while the first still matched.
    const hostFlags = args.filter(
      (a) => a === "-H" || a === "--hostname" || a.startsWith("--hostname=") || /^-H./.test(a),
    );
    expect(hostFlags).toEqual(["-H"]);
    expect(args[args.indexOf("-H") + 1]).toBe("127.0.0.1");
  });

  it("the terminal sidecar binds 127.0.0.1", () => {
    const source = readFileSync(path.join(root, "term-server/index.ts"), "utf8");
    expect(source).toMatch(/^const HOST = "127\.0\.0\.1";$/m);
    // And the server actually uses it: a constant nobody passes guards nothing.
    expect(source).toMatch(/new WebSocketServer\(\{[^}]*\bhost: HOST\b/);
  });
});
