// ABOUTME: Saves markdown content to Seren Notes via the Gateway publisher proxy.
// ABOUTME: Retries silently on 408 (scale-to-zero DB cold start) before giving up.

import { API_BASE } from "@/lib/config";
import { openExternalLink } from "@/lib/external-link";
import { appFetch } from "@/lib/fetch";
import { unwrapPublisherBody } from "@/lib/publisher-response";
import { shouldUseRustGatewayAuth } from "@/lib/tauri-fetch";
import { getToken } from "@/services/auth";

const RETRY_DELAYS_MS = [10_000, 20_000];

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
    const payload = unwrapPublisherBody(result) as
      | { data?: { id?: string }; id?: string }
      | undefined;
    const noteId = payload?.data?.id ?? payload?.id;
    if (!noteId) throw new Error("Note created but ID missing from response");

    openExternalLink(`https://notes.serendb.com/notes/${noteId}`);
    return;
  }
}
