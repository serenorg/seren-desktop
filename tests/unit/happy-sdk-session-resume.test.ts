// ABOUTME: Exercises the installed Happy SDK patch through its public API.
// ABOUTME: Proves stable data keys and resume cursors survive package patching/install.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient, configuration } from "happy/lib";
import nacl from "tweetnacl";

const servers: Array<ReturnType<typeof createServer>> = [];
const originalServerUrl = configuration.serverUrl;

afterEach(async () => {
  configuration.serverUrl = originalServerUrl;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function startSyntheticRelay() {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== "POST" || request.url !== "/v1/sessions") {
      response.writeHead(404).end();
      return;
    }
    void readJson(request).then((body) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          session: {
            id: "synthetic-stable-relay-row",
            seq: 7,
            metadata: body.metadata,
            metadataVersion: 1,
            agentState: body.agentState,
            agentStateVersion: 1,
          },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("installed Happy session resume patch", () => {
  it("reopens with the supplied key and applies the cursor before socket startup", async () => {
    configuration.serverUrl = await startSyntheticRelay();
    const keyPair = nacl.box.keyPair();
    const api = await ApiClient.create({
      token: "synthetic-token",
      encryption: {
        type: "dataKey",
        publicKey: keyPair.publicKey,
        machineKey: new Uint8Array(32).fill(4),
      },
    });
    const encryptionKey = new Uint8Array(32).fill(9);
    const options = {
      tag: "synthetic-stable-tag",
      metadata: { path: "/synthetic/project", host: "synthetic-host" },
      state: null,
      encryptionKey,
    };

    const first = await api.getOrCreateSession(options);
    const reopened = await api.getOrCreateSession(options);
    expect(Buffer.from(first!.encryptionKey)).toEqual(Buffer.from(encryptionKey));
    expect(Buffer.from(reopened!.encryptionKey)).toEqual(Buffer.from(encryptionKey));
    expect(reopened!.metadata).toEqual(options.metadata);

    const client = api.sessionSyncClient(reopened!, { resumeFromSeq: 7 });
    expect((client as unknown as { lastSeq: number }).lastSeq).toBe(7);
    expect(() => api.sessionSyncClient(reopened!, { resumeFromSeq: -1 })).toThrow(
      /non-negative safe integer/,
    );
    await client.close();
  });
});
