// ABOUTME: Guards the configurable MCP idle ping timeout used by long browser workflows.

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DualStdioServerTransport,
  pingTimeoutMsFromEnv,
} from "../dual_stdio_transport.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("playwright-stealth MCP ping timeout", () => {
  it("maps PLAYWRIGHT_MCP_PING_TIMEOUT_MS to the transport idle timeout", () => {
    expect(
      pingTimeoutMsFromEnv({ PLAYWRIGHT_MCP_PING_TIMEOUT_MS: "2000" }),
    ).toBe(2000);
  });

  it("leaves idle timeout disabled when the env var is unset", async () => {
    vi.useFakeTimers();
    const transport = new DualStdioServerTransport(
      new PassThrough(),
      new PassThrough(),
      { idleTimeoutMs: pingTimeoutMsFromEnv({}) },
    );
    let closed = false;
    transport.onclose = () => {
      closed = true;
    };

    await transport.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(closed).toBe(false);
    await transport.close();
  });

  it("closes after the configured no-traffic idle timeout", async () => {
    vi.useFakeTimers();
    const transport = new DualStdioServerTransport(
      new PassThrough(),
      new PassThrough(),
      { idleTimeoutMs: 2_000 },
    );
    let closed = false;
    transport.onclose = () => {
      closed = true;
    };

    await transport.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(closed).toBe(true);
  });

  it("keeps the transport open when idle time is below the configured timeout", async () => {
    vi.useFakeTimers();
    const transport = new DualStdioServerTransport(
      new PassThrough(),
      new PassThrough(),
      { idleTimeoutMs: 10_000 },
    );
    let closed = false;
    transport.onclose = () => {
      closed = true;
    };

    await transport.start();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(closed).toBe(false);
    await transport.close();
  });
});
