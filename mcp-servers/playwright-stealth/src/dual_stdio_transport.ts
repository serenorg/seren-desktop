// ABOUTME: Stdio MCP transport that accepts both legacy newline JSON-RPC and
// ABOUTME: Content-Length framed JSON-RPC used by newer first-party callers.

import process from "node:process";
import type { Readable, Writable } from "node:stream";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";

type FramingMode = "line" | "content-length";

type HeaderBoundary = {
  index: number;
  length: number;
};

type ParsedMessage = {
  message: JSONRPCMessage;
  framing: FramingMode;
};

const CONTENT_LENGTH_PREFIX = "content-length:";

function parseMessage(json: string): JSONRPCMessage {
  return JSONRPCMessageSchema.parse(JSON.parse(json));
}

function findHeaderBoundary(buffer: Buffer): HeaderBoundary | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");

  if (crlf === -1 && lf === -1) {
    return null;
  }

  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }

  return { index: lf, length: 2 };
}

function extractContentLength(headers: string): number | null {
  const match = headers.match(/(?:^|\r?\n)content-length:\s*(\d+)\s*(?:\r?\n|$)/i);
  if (!match) {
    return null;
  }

  const length = Number(match[1]);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function mayBeContentLengthHeader(buffer: Buffer): boolean {
  const prefix = buffer
    .subarray(0, Math.min(buffer.length, CONTENT_LENGTH_PREFIX.length))
    .toString("utf8")
    .toLowerCase();

  return (
    prefix.startsWith(CONTENT_LENGTH_PREFIX) ||
    CONTENT_LENGTH_PREFIX.startsWith(prefix)
  );
}

function serializeLineMessage(message: JSONRPCMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function serializeContentLengthMessage(message: JSONRPCMessage): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

/**
 * The MCP SDK version currently bundled here only supports newline-delimited
 * stdio messages. Seren Desktop still uses that legacy framing, while the
 * Prophet skill's Python gateway speaks the newer Content-Length framing. This
 * transport accepts either form and mirrors the response framing used by the
 * caller that initialized the process.
 */
export class DualStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private buffer?: Buffer;
  private responseFraming: FramingMode = "line";
  private started = false;

  private readonly onData = (chunk: Buffer) => {
    this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
    this.processReadBuffer();
  };

  private readonly onError = (error: Error) => {
    this.onerror?.(error);
  };

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error(
        "DualStdioServerTransport already started! If using Server class, note that connect() calls start() automatically.",
      );
    }

    this.started = true;
    this.stdin.on("data", this.onData);
    this.stdin.on("error", this.onError);
  }

  async close(): Promise<void> {
    this.stdin.off("data", this.onData);
    this.stdin.off("error", this.onError);
    this.buffer = undefined;
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      const payload =
        this.responseFraming === "content-length"
          ? serializeContentLengthMessage(message)
          : serializeLineMessage(message);

      if (this.stdout.write(payload)) {
        resolve();
      } else {
        this.stdout.once("drain", resolve);
      }
    });
  }

  private processReadBuffer(): void {
    while (true) {
      try {
        const parsed = this.readMessage();
        if (parsed === null) {
          break;
        }

        this.responseFraming = parsed.framing;
        this.onmessage?.(parsed.message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private readMessage(): ParsedMessage | null {
    if (!this.buffer || this.buffer.length === 0) {
      return null;
    }

    if (mayBeContentLengthHeader(this.buffer)) {
      return this.readContentLengthMessage();
    }

    return this.readLineMessage();
  }

  private readContentLengthMessage(): ParsedMessage | null {
    if (!this.buffer) {
      return null;
    }

    const boundary = findHeaderBoundary(this.buffer);
    if (!boundary) {
      return null;
    }

    const headers = this.buffer.toString("utf8", 0, boundary.index);
    const contentLength = extractContentLength(headers);
    if (contentLength === null) {
      this.buffer = this.buffer.subarray(boundary.index + boundary.length);
      throw new Error("Invalid MCP stdio frame: missing valid Content-Length header");
    }

    const bodyStart = boundary.index + boundary.length;
    const bodyEnd = bodyStart + contentLength;
    if (this.buffer.length < bodyEnd) {
      return null;
    }

    const body = this.buffer.toString("utf8", bodyStart, bodyEnd);
    this.buffer = this.buffer.subarray(bodyEnd);

    return {
      message: parseMessage(body),
      framing: "content-length",
    };
  }

  private readLineMessage(): ParsedMessage | null {
    if (!this.buffer) {
      return null;
    }

    while (this.buffer.length > 0) {
      const lineEnd = this.buffer.indexOf("\n");
      if (lineEnd === -1) {
        return null;
      }

      const rawLine = this.buffer.toString("utf8", 0, lineEnd);
      this.buffer = this.buffer.subarray(lineEnd + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (line.trim().length === 0) {
        continue;
      }

      return {
        message: parseMessage(line),
        framing: "line",
      };
    }

    return null;
  }
}
