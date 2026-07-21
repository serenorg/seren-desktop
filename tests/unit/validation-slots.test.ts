// ABOUTME: Protects validation slot allocation and matched Tauri config generation.
// ABOUTME: Uses real loopback ports and filesystem leases to cover concurrency.

import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireValidationSlot,
  VALIDATION_BASE_PORT,
  VALIDATION_SLOT_COUNT,
  validationIdentifierForPort,
  validationTauriConfigForPort,
  type ValidationSlot,
} from "../../scripts/validation-slots";

const cleanupDirectories: string[] = [];
const activeLeases: ValidationSlot[] = [];

afterEach(async () => {
  await Promise.all(activeLeases.splice(0).map((lease) => lease.release()));
  await Promise.all(
    cleanupDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("validation slots", () => {
  it("generates a matched strict-port config and isolated identifier", () => {
    const port = VALIDATION_BASE_PORT + 4;
    expect(validationIdentifierForPort(port)).toBe(
      "com.serendb.desktop.validation.slot1426",
    );
    expect(validationTauriConfigForPort(port)).toEqual({
      identifier: "com.serendb.desktop.validation.slot1426",
      build: {
        beforeDevCommand:
          "pnpm prepare:mcp-servers && pnpm build:provider-runtime && pnpm dev --host 127.0.0.1 --port 1426 --strictPort",
        devUrl: "http://127.0.0.1:1426",
      },
    });
  });

  it("leases ten concurrent slots and refuses an eleventh owner", async () => {
    const leaseDirectory = await mkdtemp(
      path.join(os.tmpdir(), "seren-validation-slot-test-"),
    );
    cleanupDirectories.push(leaseDirectory);
    const candidatePorts = await reserveFreePortNumbers(VALIDATION_SLOT_COUNT);

    activeLeases.push(
      ...(await Promise.all(
        Array.from({ length: VALIDATION_SLOT_COUNT }, () =>
          acquireValidationSlot({
            candidatePorts,
            env: {},
            leaseDirectory,
          }),
        ),
      )),
    );

    expect(new Set(activeLeases.map((lease) => lease.port)).size).toBe(
      VALIDATION_SLOT_COUNT,
    );
    await expect(
      acquireValidationSlot({ candidatePorts, env: {}, leaseDirectory }),
    ).rejects.toThrow("No validation slot is available");
  });

  it("skips a port occupied outside the lease registry", async () => {
    const occupied = await listenOnEphemeralPort();
    const [freePort] = await reserveFreePortNumbers(1);
    if (!freePort) throw new Error("Expected a free loopback port");
    const leaseDirectory = await mkdtemp(
      path.join(os.tmpdir(), "seren-validation-slot-test-"),
    );
    cleanupDirectories.push(leaseDirectory);

    try {
      const lease = await acquireValidationSlot({
        candidatePorts: [occupied.port, freePort],
        env: {},
        leaseDirectory,
      });
      activeLeases.push(lease);
      expect(lease.port).toBe(freePort);
    } finally {
      await closeServer(occupied.server);
    }
  });

  it("honors and validates an explicit diagnostic port override", async () => {
    const [port] = await reserveFreePortNumbers(1);
    if (!port) throw new Error("Expected a free loopback port");
    const leaseDirectory = await mkdtemp(
      path.join(os.tmpdir(), "seren-validation-slot-test-"),
    );
    cleanupDirectories.push(leaseDirectory);

    const lease = await acquireValidationSlot({
      env: { SEREN_VALIDATION_DEV_PORT: String(port) },
      leaseDirectory,
    });
    activeLeases.push(lease);
    expect(lease.port).toBe(port);
    expect(lease.identifier).toBe(
      `com.serendb.desktop.validation.slot${port}`,
    );

    await expect(
      acquireValidationSlot({ env: { SEREN_VALIDATION_DEV_PORT: "not-a-port" } }),
    ).rejects.toThrow(
      "SEREN_VALIDATION_DEV_PORT must be an integer from 1 to 65535",
    );
  });
});

async function reserveFreePortNumbers(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () => listenOnEphemeralPort()),
  );
  const ports = servers.map(({ port }) => port);
  await Promise.all(servers.map(({ server }) => closeServer(server)));
  return ports;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function listenOnEphemeralPort(): Promise<{
  server: net.Server;
  port: number;
}> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a loopback TCP address"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}
