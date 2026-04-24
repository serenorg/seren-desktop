// ABOUTME: SerenWhisper API client for speech-to-text transcription.
// ABOUTME: Uses SerenBucks via /publishers endpoint with multipart support.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { publisherStatus, unwrapPublisherBody } from "@/lib/publisher-response";
import { shouldUseRustGatewayAuth } from "@/lib/tauri-fetch";
import { getToken } from "@/services/auth";

const PUBLISHER_SLUG = "seren-whisper";

interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  content_type?: string;
  data?: string;
}

interface MultipartBody {
  parts: MultipartPart[];
}

/**
 * Convert a Blob to a base64-encoded string using FileReader.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("Failed to read audio data"));
    reader.readAsDataURL(blob);
  });
}

/** Map mime types to file extensions for the upload filename. */
const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/ogg": "ogg",
};

/**
 * Transcribe audio using the Seren Whisper publisher.
 * Sends audio as multipart/form-data via the Gateway.
 */
export async function transcribeAudio(
  audioBlob: Blob,
  mimeType = "audio/webm",
): Promise<string> {
  const base64Audio = await blobToBase64(audioBlob);

  // Use unified /publishers endpoint with multipart body structure
  const payload: MultipartBody = {
    parts: [
      { name: "model", value: "whisper-1" },
      {
        name: "file",
        filename: `audio.${MIME_EXTENSIONS[mimeType] || "webm"}`,
        content_type: mimeType,
        data: base64Audio,
      },
    ],
  };
  const url = `${apiBase}/publishers/${PUBLISHER_SLUG}/audio/transcriptions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!shouldUseRustGatewayAuth(url)) {
    const token = await getToken();
    if (!token) {
      throw new Error("Not authenticated - please log in");
    }
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await appFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[Whisper] HTTP error:", response.status, errorText);
    throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log("[Whisper] Raw API response:", JSON.stringify(result));

  // Seren wraps publisher responses in DataResponse, with upstream status inside.
  const status = publisherStatus(result);
  if (status && status !== 200) {
    const body = unwrapPublisherBody(result) as Record<string, unknown>;
    const error = body?.error as Record<string, unknown> | undefined;
    const msg =
      typeof error?.message === "string"
        ? error.message
        : `Upstream error: ${status}`;
    console.error("[Whisper] Gateway upstream error:", msg);
    throw new Error(msg);
  }

  const responsePayload = unwrapPublisherBody(result) as Record<
    string,
    unknown
  >;
  const text = responsePayload.text;
  if (!text) {
    console.error("[Whisper] No text in response:", JSON.stringify(result));
    throw new Error("No transcription returned from Whisper API");
  }

  return String(text);
}
