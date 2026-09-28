import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FOCUS_ITERM_SESSION } from "@/lib/osascript";

/**
 * The focus endpoint is the only thing in this app that acts on the world outside
 * it, so these tests are mostly about what it *refuses*. Each gate is asserted to
 * block before `osascript` is reached — a rejection that still ran the command
 * would be no rejection at all.
 */

const runCommand = vi.hoisted(() => vi.fn());
vi.mock("@/lib/exec", () => ({ runCommand, tryCommand: vi.fn() }));

const platform = vi.hoisted(() => vi.fn(() => "darwin"));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform,
}));

const ORIGIN = "http://localhost:3737";
const HOST = "localhost:3737";

function post(
  body: unknown,
  headers: Record<string, string> = { origin: ORIGIN, host: HOST },
) {
  return new Request(`${ORIGIN}/api/sessions/focus`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function callPOST(request: Request) {
  const { POST } = await import("@/app/api/sessions/focus/route");
  return POST(request);
}

beforeEach(() => {
  vi.resetModules();
  platform.mockReturnValue("darwin");
  runCommand.mockResolvedValue("focused\n");
});

afterEach(() => {
  runCommand.mockReset();
});

describe("POST /api/sessions/focus", () => {
  it("focuses a valid terminal", async () => {
    const res = await callPOST(post({ tty: "/dev/ttys001" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      focused: true,
      detail: "Brought to the front.",
    });
  });

  it("passes the tty as an argument, never inside the script", async () => {
    // This is what makes escaping unnecessary. The script must reach osascript
    // byte-for-byte as written, with the target alongside it as argv.
    await callPOST(post({ tty: "/dev/ttys001" }));
    expect(runCommand).toHaveBeenCalledWith("osascript", [
      "-e",
      FOCUS_ITERM_SESSION,
      "/dev/ttys001",
    ]);
  });

  it("refuses a cross-origin request", async () => {
    const res = await callPOST(
      post({ tty: "/dev/ttys001" }, { origin: "https://evil.example", host: HOST }),
    );
    expect(res.status).toBe(403);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses a DNS-rebinding request, where Origin and Host match but aren't local", async () => {
    const res = await callPOST(
      post(
        { tty: "/dev/ttys001" },
        { origin: "http://evil.example:3737", host: "evil.example:3737" },
      ),
    );
    expect(res.status).toBe(403);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses a request with no Origin header", async () => {
    const res = await callPOST(post({ tty: "/dev/ttys001" }, { host: HOST }));
    expect(res.status).toBe(403);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses an origin on the same host but a different port", async () => {
    const res = await callPOST(
      post({ tty: "/dev/ttys001" }, { origin: "http://localhost:3000", host: HOST }),
    );
    expect(res.status).toBe(403);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses a tty that isn't a terminal device", async () => {
    for (const tty of ["/etc/passwd", "ttys001", "/dev/ttys", 42, null]) {
      runCommand.mockClear();
      const res = await callPOST(post({ tty }));
      expect(res.status).toBe(400);
      expect(runCommand).not.toHaveBeenCalled();
    }
  });

  it("refuses an AppleScript break-out attempt without running anything", async () => {
    const res = await callPOST(
      post({ tty: '/dev/ttys001" & do shell script "touch /tmp/pwned' }),
    );
    expect(res.status).toBe(400);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("refuses a missing tty", async () => {
    const res = await callPOST(post({}));
    expect(res.status).toBe(400);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects a malformed body as a bad request, not a server error", async () => {
    const res = await callPOST(post("not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/JSON/i);
  });

  it("rejects a body that parses to null without throwing on it", async () => {
    // "null" is valid JSON, so it clears the parse and reaches the property
    // read — the case the optional chain exists for, and the only one that
    // would turn a bad request into a 500.
    const res = await callPOST(post("null"));
    expect(res.status).toBe(400);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("rejects other non-object bodies the same way", async () => {
    for (const body of ["42", '"a string"', "[]"]) {
      runCommand.mockClear();
      const res = await callPOST(post(body));
      expect(res.status).toBe(400);
      expect(runCommand).not.toHaveBeenCalled();
    }
  });

  it("declines on a host that isn't macOS", async () => {
    platform.mockReturnValue("linux");
    const res = await callPOST(post({ tty: "/dev/ttys001" }));
    expect(res.status).toBe(400);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("reports a terminal that has since closed as an ordinary outcome", async () => {
    runCommand.mockResolvedValue("not-found");
    const res = await callPOST(post({ tty: "/dev/ttys001" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.focused).toBe(false);
    expect(body.detail).toMatch(/no longer open/i);
  });

  it("reports iTerm2 not being open", async () => {
    runCommand.mockResolvedValue("not-running");
    const body = await (await callPOST(post({ tty: "/dev/ttys001" }))).json();
    expect(body).toMatchObject({ focused: false });
    expect(body.detail).toMatch(/isn't running/i);
  });

  it("turns a macOS Automation refusal into the setting that fixes it", async () => {
    runCommand.mockRejectedValue(
      new Error("Not authorized to send Apple events to iTerm2. (-1743)"),
    );
    const res = await callPOST(post({ tty: "/dev/ttys001" }));
    expect(res.status).toBe(500);
    expect((await res.json()).detail).toMatch(/System Settings/);
  });

  it("surfaces any other failure rather than claiming success", async () => {
    runCommand.mockRejectedValue(new Error("osascript: not found"));
    const res = await callPOST(post({ tty: "/dev/ttys001" }));
    expect(res.status).toBe(500);
    expect((await res.json())).toMatchObject({
      focused: false,
      detail: "osascript: not found",
    });
  });
});
