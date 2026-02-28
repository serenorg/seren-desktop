// ABOUTME: Seren DocReader service for extracting text content from documents.
// ABOUTME: Calls the seren-docreader publisher to convert Office files and PDFs to AI-readable text.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/services/auth";
import { updateBalanceFromError } from "@/stores/wallet.store";
import type { Attachment } from "@/lib/providers/types";

interface DocReaderResponseBody {
  text?: string;
  content?: string;
  pages?: Array<{ text?: string; content?: string }>;
}

interface DocReaderResponse extends DocReaderResponseBody {
  status?: number;
  body?: DocReaderResponseBody;
  cost?: string;
}

function extractText(payload: DocReaderResponseBody): string | undefined {
  if (payload.text?.trim()) return payload.text;
  if (payload.content?.trim()) return payload.content;
  if (payload.pages?.length) {
    const joined = payload.pages
      .map((p) => p.text ?? p.content ?? "")
      .filter(Boolean)
      .join("\n\n");
    if (joined.trim()) return joined;
  }
  return undefined;
}

/**
 * Extract text from a document using the seren-docreader publisher.
 * Supports PDFs, Word, Excel, and PowerPoint files.
 */
export async function readDocument(attachment: Attachment): Promise<string> {
  console.log(
    "[DocReader] Processing:",
    attachment.name,
    attachment.mimeType,
    "size:",
    Math.round(attachment.base64.length / 1024),
    "KB base64",
  );

  const token = await getToken();
  if (!token) {
    console.error("[DocReader] No auth token available");
    throw new Error(
      "Document processing requires a Seren account. Sign in to continue.",
    );
  }

  const url = `${apiBase}/publishers/seren-docreader/process`;
  console.log("[DocReader] POST", url);

  const response = await appFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ file: attachment.base64 }),
  });

  console.log("[DocReader] Response:", response.status, response.statusText);

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error(
      "[DocReader] Error response:",
      response.status,
      errorText.slice(0, 500),
    );
    if (response.status === 402) {
      updateBalanceFromError(errorText);
      throw new Error(
        "Insufficient SerenBucks balance. Add funds to process documents.",
      );
    }
    if (response.status === 401) {
      throw new Error(
        "Document processing requires a Seren account. Sign in to continue.",
      );
    }
    throw new Error(`DocReader error ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as DocReaderResponse;
  console.log("[DocReader] Response payload keys:", Object.keys(data));
  // Seren gateway wraps upstream responses in { status, body, cost }
  const payload: DocReaderResponseBody = data.body ?? data;
  const text = extractText(payload);

  if (!text) {
    console.error(
      "[DocReader] No text extracted from payload:",
      JSON.stringify(data).slice(0, 500),
    );
    throw new Error(`DocReader returned no content for ${attachment.name}`);
  }

  console.log(
    "[DocReader] Success:",
    attachment.name,
    "extracted",
    text.length,
    "chars",
  );
  return text;
}
