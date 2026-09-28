import { NextResponse, type NextRequest } from "next/server";
import { isAllowedHost } from "@/lib/sessions";

/**
 * Refuses any request whose `Host` isn't this machine, before it reaches a page
 * or an API route. This is the DNS-rebinding guard: see `isAllowedHost`.
 *
 * It covers the reads as well as the writes. `/api/github` and `/api/linear`
 * return private data, and `/api/terminal` hands out the sidecar's token, so a
 * rebinding page that could read them would not need to write anything.
 */
export function proxy(request: NextRequest) {
  if (isAllowedHost(request.headers.get("host"))) return NextResponse.next();
  return new NextResponse(
    "Pitwall only answers requests addressed to localhost or 127.0.0.1.\n",
    { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

export const config = { matcher: "/:path*" };
