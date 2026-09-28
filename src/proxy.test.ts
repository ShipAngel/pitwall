import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

function request(path: string, host: string) {
  return new NextRequest(`http://${host}${path}`, { headers: { host } });
}

describe("proxy", () => {
  it("lets a request addressed to this machine through", () => {
    const res = proxy(request("/api/github", "localhost:3737"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("403s a DNS-rebinding request before it reaches any route", () => {
    for (const path of ["/", "/api/github", "/api/linear", "/api/terminal"]) {
      const res = proxy(request(path, "evil.example:3737"));
      expect(res.status).toBe(403);
    }
  });

  it("runs on every path, not just the API", () => {
    expect(config.matcher).toBe("/:path*");
  });
});
