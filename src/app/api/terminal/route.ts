import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";
import { terminalsEnabled } from "@/lib/terminal";
import {
  TerminalServerNotRunning,
  readTerminalRuntime,
} from "@/lib/terminalRuntime";
import type { TerminalHandshake } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Hands the browser the socket URL and token for the terminal sidecar.
 *
 * The token is never in the page bundle or in config: the sidecar mints one per
 * boot and writes it to a 0600 file, and this route is the only way to read it.
 * So a page that cannot reach same-origin /api/terminal cannot reach the sidecar
 * either, and restarting the sidecar invalidates every outstanding token.
 */
export async function GET() {
  try {
    const config = await readConfig();
    if (!terminalsEnabled(config)) {
      const off: TerminalHandshake = { enabled: false, wsUrl: "", token: "" };
      return NextResponse.json(off);
    }

    const { port, token } = await readTerminalRuntime();
    const handshake: TerminalHandshake = {
      enabled: true,
      wsUrl: `ws://127.0.0.1:${port}`,
      token,
    };
    return NextResponse.json(handshake);
  } catch (err) {
    // Enabled in config but nothing listening is almost always the sidecar not
    // being started, so it gets a 503 and a message saying how to start it.
    if (err instanceof TerminalServerNotRunning) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
