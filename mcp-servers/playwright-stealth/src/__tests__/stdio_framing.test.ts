// ABOUTME: End-to-end contract tests for first-party MCP stdio framing modes.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type Child = ReturnType<typeof spawn>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "../..");
const serverPath = path.join(packageRoot, "dist", "index.js");
const tscPath = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc");

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "stdio-framing-test",
      version: "1.0.0",
    },
  },
};

const children = new Set<Child>();

function buildServer(): void {
  const result = spawnSync(process.execPath, [tscPath], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to build playwright-stealth MCP server.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function startServer(): { child: Child; stderr: string[] } {
  const stderr: string[] = [];
  const child = spawn(process.execPath, [serverPath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      BROWSER_TYPE: "chrome",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  children.add(child);
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(chunk.toString("utf8"));
  });

  return { child, stderr };
}

function stopServer(child: Child): void {
  children.delete(child);
  if (!child.killed) {
    child.kill("SIGTERM");
  }
}

function waitForStdout(
  child: Child,
  stderr: string[],
  predicate: (buffer: Buffer) => unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for MCP response.\nstdout:\n${stdout.toString("utf8")}\nstderr:\n${stderr.join("")}`,
        ),
      );
    }, 5000);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      const result = predicate(stdout);
      if (result) {
        clearTimeout(timeout);
        resolve(result);
      }
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `MCP server exited before response (code=${code}, signal=${signal}).\nstderr:\n${stderr.join("")}`,
        ),
      );
    });
  });
}

function parseLineResponse(buffer: Buffer): unknown | null {
  const lineEnd = buffer.indexOf("\n");
  if (lineEnd === -1) {
    return null;
  }

  return JSON.parse(buffer.toString("utf8", 0, lineEnd));
}

function parseContentLengthResponse(buffer: Buffer): unknown | null {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return null;
  }

  const headers = buffer.toString("utf8", 0, headerEnd);
  const match = headers.match(/(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i);
  if (!match) {
    throw new Error(`Missing Content-Length header in response: ${headers}`);
  }

  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + Number(match[1]);
  if (buffer.length < bodyEnd) {
    return null;
  }

  return JSON.parse(buffer.toString("utf8", bodyStart, bodyEnd));
}

beforeAll(buildServer);

afterEach(() => {
  for (const child of children) {
    stopServer(child);
  }
});

describe("playwright-stealth MCP stdio framing", () => {
  it("returns a Content-Length initialize response for the Prophet gateway framing", async () => {
    const { child, stderr } = startServer();
    const responsePromise = waitForStdout(
      child,
      stderr,
      parseContentLengthResponse,
    );
    const body = JSON.stringify(initializeRequest);

    child.stdin?.write(
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`,
    );

    const response = await responsePromise;
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: initializeRequest.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "playwright-stealth",
          version: "1.0.0",
        },
      },
    });
  });

  it("keeps newline-delimited initialize responses for the Desktop MCP client", async () => {
    const { child, stderr } = startServer();
    const responsePromise = waitForStdout(child, stderr, parseLineResponse);

    child.stdin?.write(`${JSON.stringify(initializeRequest)}\n`);

    const response = await responsePromise;
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: initializeRequest.id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: {
          name: "playwright-stealth",
          version: "1.0.0",
        },
      },
    });
  });
});
