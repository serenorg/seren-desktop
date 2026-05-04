// ABOUTME: Saves markdown content to Seren Notes via the Gateway publisher proxy.
// ABOUTME: Retries silently on 408 (scale-to-zero DB cold start) before giving up.

import { API_BASE } from "@/lib/config";
import { openExternalLink } from "@/lib/external-link";
import { appFetch } from "@/lib/fetch";
import { publisherStatus, unwrapPublisherBody } from "@/lib/publisher-response";
import { shouldUseRustGatewayAuth } from "@/lib/tauri-fetch";
import { getToken } from "@/services/auth";

const RETRY_DELAYS_MS = [10_000, 20_000];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Walk a parsed JSON response from POST /publishers/seren-notes/notes and
// return the upstream note id. Tolerates every envelope we have observed:
//   • upstream raw: { id, ... }
//   • upstream NoteDataResponse: { data: { id, ... } }
//   • Gateway publisher-proxy: { data: { status, body, cost } } where body
//     is either a parsed object or a JSON-encoded string (older proxy build).
//   • DataResponse with extra siblings (e.g. request_id) that block the
//     strict outer unwrap in unwrapDataResponse.
// Returns the first UUID-shaped id encountered; nothing else opens a valid
// notes.serendb.com URL, so we refuse anything that isn't a UUID.
export function extractNoteId(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  const queue: unknown[] = [value];
  while (queue.length) {
    const node = queue.shift();
    if (typeof node === "string") {
      // Some Gateway builds JSON-encode the upstream body as a string.
      if (node.startsWith("{") || node.startsWith("[")) {
        try {
          queue.push(JSON.parse(node));
        } catch {
          // Not JSON, ignore.
        }
      }
      continue;
    }
    if (!node || typeof node !== "object") continue;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    const record = node as Record<string, unknown>;
    if (typeof record.id === "string" && UUID_RE.test(record.id)) {
      return record.id;
    }
    for (const child of Object.values(record)) {
      if (child && (typeof child === "object" || typeof child === "string")) {
        queue.push(child);
      }
    }
  }
  return undefined;
}

export async function saveToSerenNotes(
  title: string,
  content: string,
): Promise<void> {
  const url = `${API_BASE}/publishers/seren-notes/notes`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!shouldUseRustGatewayAuth(url)) {
    const token = await getToken();
    if (!token) throw new Error("Not authenticated");
    headers.Authorization = `Bearer ${token}`;
  }

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const response = await appFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ title, content, format: "markdown" }),
    });

    if (response.status === 408) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw new Error("Seren Notes timed out");
    }

    if (!response.ok) {
      throw new Error(`Notes API returned ${response.status}`);
    }

    const result = await response.json();

    // Publisher-inner 408: Gateway returns transport 200 with the upstream
    // status carried inside the {data:{status,body,cost}} envelope. The
    // transport-408 branch above never fires for this case, so the original
    // cold-start retry was a no-op every time. Treat inner 408 the same as
    // transport 408 — and surface other inner-error statuses without
    // attempting to extract a note id we know is not there.
    const innerStatus = publisherStatus(result);
    if (innerStatus === 408) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw new Error("Seren Notes timed out");
    }
    if (innerStatus !== undefined && innerStatus >= 400) {
      throw new Error(`Notes API returned ${innerStatus}`);
    }

    // Try the documented envelope first; fall back to a tolerant walk that
    // covers proxy variants (string-encoded body, missing `status` key, extra
    // top-level siblings) so a saved note still resolves to a usable URL.
    const direct = unwrapPublisherBody(result) as
      | { data?: { id?: string }; id?: string }
      | string
      | undefined;
    let noteId: string | undefined;
    if (direct && typeof direct === "object") {
      noteId = direct.data?.id ?? direct.id;
    }
    if (!noteId) {
      noteId = extractNoteId(result);
    }
    if (!noteId) {
      console.error(
        "[SerenNotes] Saved note but could not extract id. Response:",
        JSON.stringify(result).slice(0, 800),
      );
      throw new Error(
        "Note saved to Seren Notes but the URL could not be opened.",
      );
    }

    openExternalLink(`https://notes.serendb.com/notes/${noteId}`);
    return;
  }
}
