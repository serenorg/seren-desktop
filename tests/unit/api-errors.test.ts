// ABOUTME: Critical tests for formatApiError - the helper that translates SDK errors
// ABOUTME: into user-facing messages without leaking raw HTML upstream-error bodies.

import { describe, expect, it } from "vitest";
import { formatApiError } from "@/lib/api-errors";

const html503 = `<html>
 <head><title>503 Service Temporarily Unavailable</title></head>
 <body>
 <center><h1>503 Service Temporarily Unavailable</h1></center>
 </body>
 </html>`;

function makeResponse(status: number): Response {
  return new Response(null, { status });
}

describe("formatApiError", () => {
  it("collapses raw HTML 503 bodies into a status-based message", () => {
    // The exact symptom from issue #1848: hey-api throws the HTML body as a
    // string when JSON.parse fails; we must NOT splice it into a user toast.
    const msg = formatApiError(html503, makeResponse(503), "fallback");
    expect(msg).not.toContain("<html");
    expect(msg).not.toContain("<title");
    expect(msg).toBe("Service Temporarily Unavailable (503)");
  });

  it("uses status-based message for any HTML 5xx body, not just 503", () => {
    const html502 = "<html><body><h1>502 Bad Gateway</h1></body></html>";
    expect(formatApiError(html502, makeResponse(502), "")).toBe(
      "Bad Gateway (502)",
    );
  });

  it("preserves structured JSON error detail", () => {
    const err = { detail: "Deployment is suspended" };
    expect(formatApiError(err, makeResponse(409), "fallback")).toBe(
      "Deployment is suspended",
    );
  });

  it("falls back to provided fallback for empty string error", () => {
    expect(formatApiError("", undefined, "no message provided")).toBe(
      "no message provided",
    );
  });

  it("returns plain string errors unchanged when not HTML", () => {
    expect(
      formatApiError("rate limited", makeResponse(429), "fallback"),
    ).toBe("rate limited");
  });
});
