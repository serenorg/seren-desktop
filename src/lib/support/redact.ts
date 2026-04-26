import type { SupportReportLogEntry, SupportReportPayload } from "./types";

export const MAX_SUPPORT_BUNDLE_BYTES = 5 * 1024 * 1024;

// `name` and `id` are handled separately by redactToolName/redactToolId because
// they need stricter shape checks; everything in this set is treated as a
// constrained enum-like string and only runs through the secret regex pass.
const SAFE_TOOL_ARG_KEYS = new Set([
  "kind",
  "type",
  "provider",
  "model",
  "region",
  "status",
]);

const SECRET_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /Bearer\s+[A-Za-z0-9._-]+/gi, replacement: "Bearer [REDACTED]" },
  { regex: /seren_[A-Za-z0-9_-]{8,}/g, replacement: "[REDACTED_SEREN_KEY]" },
  { regex: /sk_(?:live|test)_[A-Za-z0-9]+/g, replacement: "[REDACTED_KEY]" },
  { regex: /pk_(?:live|test)_[A-Za-z0-9]+/g, replacement: "[REDACTED_KEY]" },
  { regex: /whsec_[A-Za-z0-9]+/g, replacement: "[REDACTED_KEY]" },
  {
    regex: /gh[pousr]_[A-Za-z0-9]{20,}/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  { regex: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_KEY]" },
  { regex: /AIza[A-Za-z0-9_-]{20,}/g, replacement: "[REDACTED_GOOGLE_KEY]" },
  {
    regex: /xox[abprs]-[A-Za-z0-9-]{8,}/g,
    replacement: "[REDACTED_SLACK_TOKEN]",
  },
  { regex: /0x[a-fA-F0-9]{40,}/g, replacement: "[REDACTED_WALLET]" },
  {
    regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    replacement: "[REDACTED_UUID]",
  },
];

export function redactString(value: string): string {
  let result = value
    .replace(/(?:\/Users|\/home)\/([^/\s)]+)/g, "$HOME")
    .replace(/[A-Z]:\\Users\\([^\\\s)]+)/gi, "$HOME");

  for (const { regex, replacement } of SECRET_PATTERNS) {
    result = result.replace(regex, replacement);
  }

  return result;
}

// Tool call `name` values are user-controllable (a custom MCP tool, or a
// `toolCall.title` fallback that may carry file paths or prompts). We allow
// the field through only when it's a short identifier-shaped string so it
// cannot smuggle prose into the public GitHub issue.
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.\-:]{0,63}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function redactToolName(value: unknown): string {
  if (typeof value !== "string") return "<redacted>";
  return TOOL_NAME_PATTERN.test(value)
    ? value
    : `<redacted len=${value.length}>`;
}

export function redactToolId(value: unknown): string {
  if (typeof value !== "string") return "<redacted>";
  // Tool call IDs are typically UUIDs or short slugs. Anything free-form gets
  // length-stamped instead of leaking.
  if (UUID_PATTERN.test(value) || TOOL_NAME_PATTERN.test(value)) return value;
  return `<redacted len=${value.length}>`;
}

function safeJsonLength(item: unknown): string {
  try {
    const json = JSON.stringify(item);
    return json ? String(json.length) : "0";
  } catch {
    return "circular";
  }
}

export function redactToolArgs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactToolArgs(item));
  }

  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "name") {
        redacted[key] = redactToolName(item);
      } else if (key === "id") {
        redacted[key] = redactToolId(item);
      } else if (SAFE_TOOL_ARG_KEYS.has(key)) {
        redacted[key] = typeof item === "string" ? redactString(item) : item;
      } else if (typeof item === "string") {
        redacted[key] = `<redacted len=${item.length}>`;
      } else {
        redacted[key] = `<redacted len=${safeJsonLength(item)}>`;
      }
    }
    return redacted;
  }

  if (typeof value === "string") {
    return `<redacted len=${value.length}>`;
  }

  return value;
}

export function redactPrompt(value: string): string {
  return `<prompt len=${value.length}>`;
}

export function redactLogEntry(
  entry: SupportReportLogEntry,
): SupportReportLogEntry {
  return {
    ...entry,
    module: redactString(entry.module),
    message: redactString(entry.message),
  };
}

export function redactSupportPayload(
  payload: SupportReportPayload,
): SupportReportPayload {
  return {
    ...payload,
    error: {
      kind: redactString(payload.error.kind),
      message: redactString(payload.error.message),
      stack: payload.error.stack.map(redactString),
    },
    http: payload.http
      ? {
          ...payload.http,
          method: redactString(payload.http.method),
          url: redactString(payload.http.url),
          body: payload.http.body ? redactString(payload.http.body) : undefined,
        }
      : undefined,
    log_slice: payload.log_slice.map(redactLogEntry),
    agent_context: payload.agent_context
      ? {
          model: payload.agent_context.model
            ? redactString(payload.agent_context.model)
            : undefined,
          provider: payload.agent_context.provider
            ? redactString(payload.agent_context.provider)
            : undefined,
          region: payload.agent_context.region
            ? redactString(payload.agent_context.region)
            : undefined,
          tool_calls: payload.agent_context.tool_calls.map((tool) => ({
            name: redactToolName(tool.name),
            id: redactToolId(tool.id),
          })),
        }
      : undefined,
  };
}

export function capSupportPayload(
  payload: SupportReportPayload,
  maxBytes = MAX_SUPPORT_BUNDLE_BYTES,
): SupportReportPayload {
  let next = payload;

  while (payloadByteLength(next) > maxBytes) {
    if (next.log_slice.length > 0) {
      next = {
        ...next,
        truncated: true,
        log_slice: next.log_slice.slice(Math.ceil(next.log_slice.length / 4)),
      };
      continue;
    }

    if (next.http?.body && next.http.body.length > 1024) {
      next = {
        ...next,
        truncated: true,
        http: {
          ...next.http,
          body: truncateString(
            next.http.body,
            Math.ceil(next.http.body.length / 2),
          ),
        },
      };
      continue;
    }

    if (next.error.stack.length > 0) {
      next = {
        ...next,
        truncated: true,
        error: {
          ...next.error,
          stack: next.error.stack.slice(
            0,
            Math.floor(next.error.stack.length / 2),
          ),
        },
      };
      continue;
    }

    if (next.error.message.length > 1024) {
      next = {
        ...next,
        truncated: true,
        error: {
          ...next.error,
          message: truncateString(
            next.error.message,
            Math.ceil(next.error.message.length / 2),
          ),
        },
      };
      continue;
    }

    next = {
      ...next,
      truncated: true,
    };
    break;
  }

  return next;
}

function payloadByteLength(payload: SupportReportPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 16))}...[truncated]`;
}
