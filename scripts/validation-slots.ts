// ABOUTME: Allocates collision-free local slots for concurrent validation apps.
// ABOUTME: Couples each Vite port to a distinct Tauri identity and lease.

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const VALIDATION_BASE_PORT = 1422;
export const VALIDATION_SLOT_COUNT = 10;
export const VALIDATION_IDENTIFIER = "com.serendb.desktop.validation";

const DEFAULT_PORTS = Array.from(
  { length: VALIDATION_SLOT_COUNT },
  (_, index) => VALIDATION_BASE_PORT + index,
);
const DEFAULT_LEASE_DIRECTORY = path.join(
  os.tmpdir(),
  "seren-desktop-validation-slots",
);

interface LeaseRecord {
  ownerPid: number;
  token: string;
}

export interface ValidationSlot {
  port: number;
  identifier: string;
  tauriConfig: Record<string, unknown>;
  release(): Promise<void>;
}

export interface ValidationSlotOptions {
  candidatePorts?: number[];
  env?: NodeJS.ProcessEnv;
  leaseDirectory?: string;
}

export function validationIdentifierForPort(port: number): string {
  assertValidPort(port);
  return `${VALIDATION_IDENTIFIER}.slot${port}`;
}

export function validationTauriConfigForPort(
  port: number,
): Record<string, unknown> {
  assertValidPort(port);
  return {
    identifier: validationIdentifierForPort(port),
    build: {
      beforeDevCommand:
        `pnpm prepare:mcp-servers && pnpm build:provider-runtime && pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
      devUrl: `http://127.0.0.1:${port}`,
    },
  };
}

export async function acquireValidationSlot(
  options: ValidationSlotOptions = {},
): Promise<ValidationSlot> {
  const env = options.env ?? process.env;
  const explicitPort = parseExplicitPort(env.SEREN_VALIDATION_DEV_PORT);
  const candidatePorts = explicitPort
    ? [explicitPort]
    : (options.candidatePorts ?? DEFAULT_PORTS);
  const leaseDirectory =
    options.leaseDirectory ?? DEFAULT_LEASE_DIRECTORY;

  await mkdir(leaseDirectory, { recursive: true, mode: 0o700 });

  for (const port of candidatePorts) {
    assertValidPort(port);
    const lease = await tryAcquireLease(leaseDirectory, port);
    if (!lease) continue;

    if (!(await isPortAvailable(port))) {
      await lease.release();
      continue;
    }

    return {
      port,
      identifier: validationIdentifierForPort(port),
      tauriConfig: validationTauriConfigForPort(port),
      release: lease.release,
    };
  }

  if (explicitPort) {
    throw new Error(
      `Validation port ${explicitPort} is already leased or unavailable`,
    );
  }
  throw new Error(
    `No validation slot is available (tried ${candidatePorts.join(", ")})`,
  );
}

function parseExplicitPort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(
      "SEREN_VALIDATION_DEV_PORT must be an integer from 1 to 65535",
    );
  }
  const port = Number(raw);
  assertValidPort(port, "SEREN_VALIDATION_DEV_PORT");
  return port;
}

function assertValidPort(port: number, label = "validation port"): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
}

async function tryAcquireLease(
  leaseDirectory: string,
  port: number,
): Promise<{ release(): Promise<void> } | null> {
  const leasePath = path.join(leaseDirectory, `${port}.json`);
  const token = randomUUID();
  const record: LeaseRecord = { ownerPid: process.pid, token };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(leasePath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          const current = await readLease(leasePath);
          if (current?.token === token) {
            await rm(leasePath, { force: true });
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readLease(leasePath);
      if (existing && !isProcessAlive(existing.ownerPid)) {
        await rm(leasePath, { force: true });
        continue;
      }
      if (!existing && (await isAbandonedIncompleteLease(leasePath))) {
        await rm(leasePath, { force: true });
        continue;
      }
      return null;
    }
  }

  return null;
}

async function isAbandonedIncompleteLease(leasePath: string): Promise<boolean> {
  try {
    const metadata = await stat(leasePath);
    return Date.now() - metadata.mtimeMs > 5_000;
  } catch {
    return true;
  }
}

async function readLease(leasePath: string): Promise<LeaseRecord | null> {
  try {
    const parsed = JSON.parse(
      await readFile(leasePath, "utf8"),
    ) as Partial<LeaseRecord>;
    if (
      Number.isInteger(parsed.ownerPid) &&
      typeof parsed.token === "string" &&
      parsed.token.length > 0
    ) {
      return parsed as LeaseRecord;
    }
  } catch {
    // A truncated or abandoned record is stale and can be reclaimed.
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}
