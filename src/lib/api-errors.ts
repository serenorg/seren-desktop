// ABOUTME: Format SDK errors for user display. Redacts raw HTML upstream-error
// ABOUTME: bodies in favor of clean status-based messages.

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Server Error",
  502: "Bad Gateway",
  503: "Service Temporarily Unavailable",
  504: "Gateway Timeout",
};

function looksLikeHtml(value: string): boolean {
  const trimmed = value.trimStart();
  if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<!DOCTYPE")) {
    return true;
  }
  if (trimmed.startsWith("<")) return true;
  return /<(html|body|head|title|center)\b/i.test(value);
}

function statusMessage(
  response: Response | undefined,
  fallback: string,
): string {
  const status = response?.status;
  if (typeof status !== "number" || status === 0) return fallback;
  const text =
    STATUS_TEXT[status] ??
    (status >= 500 ? "Server Error" : status >= 400 ? "Request Failed" : "");
  return text ? `${text} (${status})` : `HTTP ${status}`;
}

export function formatApiError(
  error: unknown,
  response: Response | undefined,
  fallback: string,
): string {
  if (!error) return statusMessage(response, fallback);

  if (error instanceof Error) {
    return error.message || statusMessage(response, fallback);
  }

  if (typeof error === "string") {
    if (error.length === 0) return statusMessage(response, fallback);
    if (looksLikeHtml(error)) return statusMessage(response, fallback);
    return error;
  }

  if (typeof error === "number" || typeof error === "boolean") {
    return String(error);
  }

  if (typeof error === "object") {
    const obj = error as Record<string, unknown>;
    for (const key of [
      "message",
      "detail",
      "error_description",
      "error_message",
      "error",
      "title",
      "reason",
    ]) {
      const value = obj[key];
      if (
        typeof value === "string" &&
        value.length > 0 &&
        !looksLikeHtml(value)
      ) {
        return value;
      }
    }
    if (typeof obj.status === "number" || typeof obj.code === "string") {
      const status = typeof obj.status === "number" ? obj.status : null;
      const code = typeof obj.code === "string" ? obj.code : null;
      const tag = [status, code].filter(Boolean).join(" ");
      if (tag) return `HTTP ${tag}`;
    }
    try {
      const dump = JSON.stringify(error);
      if (dump && dump !== "{}") {
        return dump.length > 240 ? `${dump.slice(0, 237)}...` : dump;
      }
    } catch {
      // Circular ref; fall through.
    }
  }

  return statusMessage(response, fallback);
}
