import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/types";

const config = (over: Partial<AppConfig> = {}): AppConfig => ({
  repos: [{ owner: "Northwind", name: "forms-app", localPath: "~/Dev/forms-app" }],
  linear: {
    teamKey: "ENG",
  },
  refreshIntervalSeconds: 300,
  terminals: { enabled: true },
  ...over,
});

const readConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config", () => ({ readConfig }));

// The runtime file itself is read by lib/terminalRuntime, which is tested
// separately; here only the wiring matters.
const readTerminalRuntime = vi.hoisted(() => vi.fn());
vi.mock("@/lib/terminalRuntime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/terminalRuntime")>()),
  readTerminalRuntime,
}));

async function callGET() {
  const { GET } = await import("@/app/api/terminal/route");
  return GET();
}

beforeEach(() => {
  vi.resetModules();
  readConfig.mockResolvedValue(config());
  readTerminalRuntime.mockResolvedValue({ port: 3738, token: "secret-token" });
});

afterEach(() => {
  readConfig.mockReset();
  readTerminalRuntime.mockReset();
});

describe("GET /api/terminal", () => {
  it("returns the socket URL and the sidecar's token", async () => {
    const res = await callGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      enabled: true,
      wsUrl: "ws://127.0.0.1:3738",
      token: "secret-token",
    });
  });

  it("uses the port from the runtime file, not a hardcoded one", async () => {
    readTerminalRuntime.mockResolvedValue({ port: 9999, token: "t" });
    const body = await (await callGET()).json();
    expect(body.wsUrl).toBe("ws://127.0.0.1:9999");
  });

  it("reports disabled without reading the runtime file", async () => {
    readConfig.mockResolvedValue(config({ terminals: { enabled: false } }));
    const res = await callGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, wsUrl: "", token: "" });
    expect(readTerminalRuntime).not.toHaveBeenCalled();
  });

  it("reports disabled when the terminals block is absent", async () => {
    readConfig.mockResolvedValue(config({ terminals: undefined }));
    expect(await (await callGET()).json()).toMatchObject({ enabled: false });
  });

  it("hands out no token when disabled", async () => {
    readConfig.mockResolvedValue(config({ terminals: { enabled: false } }));
    expect((await (await callGET()).json()).token).toBe("");
  });

  it("503s with a startup hint when the sidecar is not running", async () => {
    const { TerminalServerNotRunning } = await import("@/lib/terminalRuntime");
    readTerminalRuntime.mockRejectedValue(new TerminalServerNotRunning());
    const res = await callGET();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not running/);
  });

  it("500s, not 503s, when the runtime file is malformed", async () => {
    readTerminalRuntime.mockRejectedValue(new Error("'token' must be a non-empty string"));
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/'token'/);
  });

  it("500s when config.json cannot be read", async () => {
    readConfig.mockRejectedValue(new Error("config.json not found"));
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/config\.json not found/);
  });

  it("propagates an unreadable runtime file as a 500", async () => {
    readTerminalRuntime.mockRejectedValue(new Error("permission denied"));
    const res = await callGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/permission denied/);
  });
});
