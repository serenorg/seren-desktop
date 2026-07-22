// ABOUTME: Guards encrypted, restart-stable persistence for Happy session data keys.
// ABOUTME: Verifies CRUD serialization, disk privacy, permissions, and fail-closed reads.

import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error — the bridge key store is plain ESM without declarations.
import {
  createHappySessionKeyStore,
  HAPPY_SESSION_KEY_STORE_FILENAME,
} from "../../bin/happy-bridge/session-key-store.mjs";

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "seren-happy-session-keys-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Happy session key store", () => {
  it("persists independent random keys without exposing ids or key material on disk", async () => {
    const directory = await temporaryDirectory();
    const machineKey = Buffer.alloc(32, 0x31);
    const sessionId = "synthetic-session-id-that-must-not-appear-on-disk";
    const otherSessionId = "second-synthetic-session";
    const store = createHappySessionKeyStore({ directory, machineKey });

    const first = await store.getOrCreate(sessionId, "seren-synthetic-session");
    const repeated = await store.getOrCreate(sessionId, "ignored-on-reopen");
    const other = await store.getOrCreate(otherSessionId, "seren-second-session");

    expect(first).toMatchObject({ state: "pending", relayTag: "seren-synthetic-session" });
    expect(first.key).toBeInstanceOf(Uint8Array);
    expect(first.key).toHaveLength(32);
    expect(Buffer.from(repeated.key)).toEqual(Buffer.from(first.key));
    expect(Buffer.from(other.key)).not.toEqual(Buffer.from(first.key));

    const persisted = await readFile(store.filePath, "utf8");
    expect(persisted).not.toContain(sessionId);
    expect(persisted).not.toContain(otherSessionId);
    expect(persisted).not.toContain("seren-synthetic-session");
    expect(persisted).not.toContain(Buffer.from(first.key).toString("base64"));
    expect(persisted).not.toContain(Buffer.from(first.key).toString("hex"));
    expect(JSON.parse(persisted)).toMatchObject({
      version: 1,
      kdf: { name: "HKDF-SHA256" },
      aead: { name: "AES-256-GCM" },
    });
    expect(await readdir(directory)).toEqual([HAPPY_SESSION_KEY_STORE_FILENAME]);
    if (process.platform !== "win32") {
      expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    }

    const reopened = createHappySessionKeyStore({ directory, machineKey });
    const ready = await reopened.markReady(sessionId, "synthetic-relay-row");
    expect(ready).toMatchObject({
      state: "ready",
      relayTag: "seren-synthetic-session",
      happySessionId: "synthetic-relay-row",
    });
    expect(Buffer.from(ready.key)).toEqual(Buffer.from(first.key));
    await expect(reopened.replacePendingTag(sessionId, "replacement")).rejects.toThrow(
      /cannot change relay tags/,
    );
    const reopenedReady = await createHappySessionKeyStore({ directory, machineKey }).getOrCreate(
      sessionId,
      "ignored-after-ready",
    );
    expect(reopenedReady).toMatchObject({
      state: "ready",
      relayTag: "seren-synthetic-session",
      happySessionId: "synthetic-relay-row",
    });
    expect(Buffer.from(reopenedReady.key)).toEqual(Buffer.from(first.key));
    await expect(reopened.markReady(sessionId, "different-relay-row")).rejects.toThrow(
      /different relay row/,
    );
    const retiring = await reopened.markRetiring(sessionId, "synthetic-relay-row");
    expect(retiring).toMatchObject({
      state: "retiring",
      happySessionId: "synthetic-relay-row",
      providerRetired: false,
      blockRevival: false,
    });
    const providerRetired = await reopened.markRetiring(
      sessionId,
      "synthetic-relay-row",
      true,
      true,
      "synthetic-conversation",
      "synthetic-agent-session",
    );
    expect(providerRetired.providerRetired).toBe(true);
    expect(providerRetired.blockRevival).toBe(true);
    expect(providerRetired.conversationId).toBe("synthetic-conversation");
    expect(providerRetired.agentSessionId).toBe("synthetic-agent-session");
    const retiringDocument = await readFile(store.filePath, "utf8");
    expect(retiringDocument).not.toContain("synthetic-conversation");
    expect(retiringDocument).not.toContain("synthetic-agent-session");
    const reopenedRetiring = await createHappySessionKeyStore({
      directory,
      machineKey,
    }).list();
    expect(reopenedRetiring).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          state: "retiring",
          providerRetired: true,
          blockRevival: true,
          conversationId: "synthetic-conversation",
          agentSessionId: "synthetic-agent-session",
        }),
      ]),
    );
    await expect(reopened.markReady(sessionId, "synthetic-relay-row")).rejects.toThrow(
      /cannot become ready/,
    );
    expect(await reopened.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId, state: "retiring", providerRetired: true }),
      ]),
    );
  });

  it("serializes concurrent writers and removes the file with the last binding", async () => {
    const directory = await temporaryDirectory();
    const machineKey = Buffer.alloc(32, 0x42);
    const firstStore = createHappySessionKeyStore({ directory, machineKey });
    const secondStore = createHappySessionKeyStore({ directory, machineKey });
    const sessionIds = Array.from({ length: 24 }, (_, index) => `concurrent-session-${index}`);

    const created = await Promise.all(
      sessionIds.map((sessionId, index) =>
        (index % 2 === 0 ? firstStore : secondStore).getOrCreate(
          sessionId,
          `seren-${sessionId}`,
        ),
      ),
    );
    const reopened = createHappySessionKeyStore({ directory, machineKey });
    for (const [index, sessionId] of sessionIds.entries()) {
      const binding = await reopened.getOrCreate(sessionId, `ignored-${sessionId}`);
      expect(Buffer.from(binding.key)).toEqual(Buffer.from(created[index].key));
    }

    expect(await reopened.delete(sessionIds[1])).toBe(true);
    const recreated = await reopened.getOrCreate(sessionIds[1], `seren-${sessionIds[1]}`);
    expect(Buffer.from(recreated.key)).not.toEqual(Buffer.from(created[1].key));
    for (const sessionId of sessionIds) expect(await reopened.delete(sessionId)).toBe(true);
    await expect(access(reopened.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await reopened.delete(sessionIds[0])).toBe(false);
  });

  it("fails closed without replacing a store encrypted by another key or corrupted on disk", async () => {
    const directory = await temporaryDirectory();
    const store = createHappySessionKeyStore({
      directory,
      machineKey: Buffer.alloc(32, 0x53),
    });
    await store.getOrCreate("protected-synthetic-session", "seren-protected-session");
    const original = await readFile(store.filePath, "utf8");
    const wrongKeyStore = createHappySessionKeyStore({
      directory,
      machineKey: Buffer.alloc(32, 0x54),
    });

    await expect(
      wrongKeyStore.getOrCreate("another-session", "seren-another-session"),
    ).rejects.toMatchObject({
      code: "ERR_HAPPY_SESSION_KEY_STORE_INVALID",
    });
    expect(await readFile(store.filePath, "utf8")).toBe(original);

    const document = JSON.parse(original);
    const ciphertext = Buffer.from(document.aead.ciphertext, "base64");
    ciphertext[0] ^= 0x01;
    document.aead.ciphertext = ciphertext.toString("base64");
    await writeFile(store.filePath, JSON.stringify(document), { mode: 0o600 });

    await expect(
      store.getOrCreate("protected-synthetic-session", "seren-protected-session"),
    ).rejects.toMatchObject({
      code: "ERR_HAPPY_SESSION_KEY_STORE_INVALID",
    });
  });

  it("rejects invalid inputs and oversized store files", async () => {
    const directory = await temporaryDirectory();
    expect(() =>
      createHappySessionKeyStore({ directory, machineKey: Buffer.alloc(31) }),
    ).toThrow(/32-byte/);

    const store = createHappySessionKeyStore({ directory, machineKey: Buffer.alloc(32, 0x65) });
    await expect(store.getOrCreate("", "valid-tag")).rejects.toThrow(/between 1 and 512 bytes/);
    await expect(store.getOrCreate("x".repeat(513), "valid-tag")).rejects.toThrow(
      /between 1 and 512 bytes/,
    );
    await expect(store.getOrCreate("valid-session", "")).rejects.toThrow(
      /relay tag must be between/,
    );
    await writeFile(
      path.join(directory, HAPPY_SESSION_KEY_STORE_FILENAME),
      Buffer.alloc(1_048_577),
      { mode: 0o600 },
    );
    await expect(store.getOrCreate("bounded-read", "seren-bounded-read")).rejects.toMatchObject({
      code: "ERR_HAPPY_SESSION_KEY_STORE_INVALID",
    });
  });
});
