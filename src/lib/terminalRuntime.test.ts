import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile }));

/** The ENOENT that means "the sidecar was never started". */
function enoent() {
  const err = new Error("no such file") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

async function read() {
  const { readTerminalRuntime } = await import("./terminalRuntime");
  return readTerminalRuntime();
}

beforeEach(() => {
  vi.resetModules();
  readFile.mockResolvedValue('{"port":3738,"token":"secret"}');
});

afterEach(() => {
  readFile.mockReset();
});

describe("readTerminalRuntime", () => {
  it("returns the port and token", async () => {
    await expect(read()).resolves.toEqual({ port: 3738, token: "secret" });
  });

  // The path is built from a literal so Turbopack can fold it; this keeps that
  // literal and the shared constant from drifting apart.
  it("reads the file named by TERMINAL_RUNTIME_FILE, in the working directory", async () => {
    const { TERMINAL_RUNTIME_FILE } = await import("./terminal");
    await read();
    expect(readFile).toHaveBeenCalledWith(
      path.join(process.cwd(), TERMINAL_RUNTIME_FILE),
      "utf-8",
    );
  });

  it("throws TerminalServerNotRunning when the file is absent", async () => {
    readFile.mockRejectedValue(enoent());
    const { TerminalServerNotRunning } = await import("./terminalRuntime");
    await expect(read()).rejects.toBeInstanceOf(TerminalServerNotRunning);
  });

  it("names npm run term in that error, so the fix is in the message", async () => {
    readFile.mockRejectedValue(enoent());
    await expect(read()).rejects.toThrow(/npm run term/);
  });

  it("rethrows other read failures unchanged", async () => {
    const err = new Error("permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    readFile.mockRejectedValue(err);
    await expect(read()).rejects.toThrow(/permission denied/);
  });

  it("propagates a validation failure from a malformed file", async () => {
    readFile.mockResolvedValue('{"port":3738}');
    await expect(read()).rejects.toThrow(/'token'/);
  });
});
