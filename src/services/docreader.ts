// ABOUTME: Seren DocReader service for extracting text content from documents.
// ABOUTME: Calls the seren-docreader publisher to convert Office files and PDFs to AI-readable text.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import type { Attachment } from "@/lib/providers/types";
import { shouldUseRustGatewayAuth } from "@/lib/tauri-fetch";
import { getToken } from "@/services/auth";
import { updateBalanceFromError } from "@/stores/wallet.store";

interface DocReaderResponseBody {
  text?: string;
  content?: unknown;
  pages?: Array<{ text?: string; content?: unknown }>;
}

interface DocReaderResponse extends DocReaderResponseBody {
  status?: number;
  body?: DocReaderResponseBody;
  cost?: string;
}

/** Safely extract a string from a field that may be a string, object, or array. */
function coerceText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    // Handle plain object: { text: "..." } or { content: "..." }
    const obj = value as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }
  if (Array.isArray(value)) {
    // Handle array of content blocks: [{type:"text", text:"..."}, ...]
    const parts = value
      .map((item) => coerceText(item))
      .filter(Boolean) as string[];
    if (parts.length) return parts.join("\n\n");
  }
  return undefined;
}

function extractText(payload: DocReaderResponseBody): string | undefined {
  const text = coerceText(payload.text);
  if (text?.trim()) return text;

  const content = coerceText(payload.content);
  if (content?.trim()) return content;

  if (payload.pages?.length) {
    const joined = payload.pages
      .map((p) => coerceText(p.text) ?? coerceText(p.content) ?? "")
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

  const url = `${apiBase}/publishers/seren-docreader/process`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!shouldUseRustGatewayAuth(url)) {
    const token = await getToken();
    if (!token) {
      console.error("[DocReader] No auth token available");
      throw new Error(
        "Document processing requires a Seren account. Sign in to continue.",
      );
    }
    headers.Authorization = `Bearer ${token}`;
  }
  console.log("[DocReader] POST", url);

  const response = await appFetch(url, {
    method: "POST",
    headers,
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
      // 402 body is JSON containing { availableBalanceAtomic: "<atomic units>" }.
      // Parse and forward the numeric balance so the wallet UI updates immediately.
      try {
        const data = JSON.parse(errorText);
        if (data.availableBalanceAtomic !== undefined) {
          const balanceAtomic = Number.parseInt(
            data.availableBalanceAtomic,
            10,
          );
          if (!Number.isNaN(balanceAtomic)) {
            updateBalanceFromError(balanceAtomic);
          }
        }
      } catch {
        // Body wasn't JSON — fall through to the user-facing error below.
      }
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
  console.log(
    "[DocReader] Payload shape:",
    "text:",
    typeof payload.text,
    "content:",
    typeof payload.content,
    Array.isArray(payload.content)
      ? `(array[${(payload.content as unknown[]).length}])`
      : "",
    "pages:",
    typeof payload.pages,
  );
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
