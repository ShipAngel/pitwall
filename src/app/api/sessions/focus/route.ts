import { platform } from "node:os";
import { NextResponse } from "next/server";
import { runCommand } from "@/lib/exec";
import { FOCUS_ITERM_SESSION } from "@/lib/osascript";
import {
  focusErrorDetail,
  focusOutcome,
  isSameOrigin,
  isValidTty,
} from "@/lib/sessions";
import type { FocusResponse } from "@/types";

export const dynamic = "force-dynamic";

/**
 * The one endpoint in this app that changes something outside it: it brings an
 * iTerm2 session to the front.
 *
 * Three gates, because the rest of the dashboard is read-only and this isn't:
 *
 *  1. **POST only.** A GET would be fetchable by any page's `<img>` or a link
 *     prefetch, and pitwall runs on a predictable localhost port.
 *  2. **Same-origin.** Refuses anything not sent by the dashboard itself.
 *  3. **Allow-listed tty.** The target must match `/dev/ttysN` exactly, and is
 *     passed to `osascript` as an argument rather than spliced into the script,
 *     so there is no string for an attacker to break out of.
 *
 * What survives all three can select a window, a tab and a pane. It cannot type
 * into a terminal or run a command.
 */
export async function POST(request: Request) {
  try {
    if (
      !isSameOrigin(request.headers.get("origin"), request.headers.get("host"))
    ) {
      return NextResponse.json(
        { focused: false, detail: "Cross-origin requests are refused." },
        { status: 403 },
      );
    }

    if (platform() !== "darwin") {
      return NextResponse.json(
        { focused: false, detail: "Focusing a terminal is supported on macOS only." },
        { status: 400 },
      );
    }

    // A malformed body is a bad request, not a server fault.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { focused: false, detail: "Expected a JSON body." },
        { status: 400 },
      );
    }

    const tty = (body as { tty?: unknown })?.tty;
    if (!isValidTty(tty)) {
      return NextResponse.json(
        { focused: false, detail: "Not a terminal device path." },
        { status: 400 },
      );
    }

    // The tty is an argument, not part of the script — see FOCUS_ITERM_SESSION.
    const stdout = await runCommand("osascript", [
      "-e",
      FOCUS_ITERM_SESSION,
      tty,
    ]);
    return NextResponse.json(focusOutcome(stdout) satisfies FocusResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    const response: FocusResponse = {
      focused: false,
      detail: focusErrorDetail(msg),
    };
    return NextResponse.json(response, { status: 500 });
  }
}
