// ABOUTME: Saves markdown content to Seren Notes via the Gateway publisher proxy.
// ABOUTME: Retries silently on 408 (scale-to-zero DB cold start) before giving up.

import { API_BASE } from "@/lib/config";
import { openExternalLink } from "@/lib/external-link";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/services/auth";

const RETRY_DELAYS_MS = [10_000, 20_000];

export async function saveToSerenNotes(
  title: string,
  content: string,
): Promise<void> {
  const token = await getToken();
  if (!token) throw new Error("Not authenticated");

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const response = await appFetch(
      `${API_BASE}/publishers/seren-notes/notes`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, content, format: "markdown" }),
      },
    );

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
    const noteId = result?.body?.data?.id ?? result?.data?.id;
    if (!noteId) throw new Error("Note created but ID missing from response");

    openExternalLink(`https://notes.serendb.com/notes/${noteId}`);
    return;
  }
}
