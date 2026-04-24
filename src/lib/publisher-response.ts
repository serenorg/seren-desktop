// ABOUTME: Helpers for Seren publisher proxy response envelopes.

export interface PublisherEnvelope<T = unknown> {
  status?: number;
  body?: T;
  cost?: string;
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
  if (isRecord(envelope) && "body" in envelope) {
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
