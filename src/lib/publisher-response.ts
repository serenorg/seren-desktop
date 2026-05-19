// ABOUTME: Helpers for Seren publisher proxy response envelopes.

export interface PublisherEnvelope<T = unknown> {
  status?: number;
  body?: T;
  cost?: string;
}

export interface PublisherErrorEnvelope {
  error: {
    code?: number | string;
    message?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function unwrapDataResponse<T = unknown>(value: unknown): T | unknown {
  if (!isRecord(value) || !("data" in value)) {
    return value;
  }
  // Only unwrap when the shape matches Seren's DataResponse<T> envelope
  // (a `data` field, optionally with `pagination`). Upstream protocol payloads
  // that happen to carry a top-level `data` field (e.g. OpenAI list responses
  // shaped `{ object: "list", data: [...], model, usage }`) must not be stripped.
  const allowed = new Set(["data", "pagination"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return value;
    }
  }
  return value.data as T;
}

export function unwrapPublisherEnvelope<T = unknown>(
  value: unknown,
): PublisherEnvelope<T> | T | unknown {
  return unwrapDataResponse<PublisherEnvelope<T>>(value);
}

export function unwrapPublisherBody<T = unknown>(value: unknown): T | unknown {
  const envelope = unwrapPublisherEnvelope<T>(value);
  // Require both `status` and `body` to recognise the publisher-proxy envelope.
  // Matching on `body` alone would wrongly strip unrelated objects that happen
  // to carry a `body` field (e.g. tool-call result payloads).
  if (isRecord(envelope) && "status" in envelope && "body" in envelope) {
    return envelope.body as T;
  }
  return envelope;
}

export function publisherStatus(value: unknown): number | undefined {
  const envelope = unwrapPublisherEnvelope(value);
  if (isRecord(envelope) && typeof envelope.status === "number") {
    return envelope.status;
  }
  return undefined;
}

export function isPublisherErrorEnvelope(
  value: unknown,
): value is PublisherErrorEnvelope {
  if (!isRecord(value)) return false;
  const err = value.error;
  if (!isRecord(err)) return false;
  return (
    typeof err.code === "number" ||
    typeof err.code === "string" ||
    typeof err.message === "string"
  );
}

export function publisherErrorMessage(value: unknown): string | null {
  if (!isPublisherErrorEnvelope(value)) return null;
  return typeof value.error.message === "string" &&
    value.error.message.length > 0
    ? value.error.message
    : null;
}
