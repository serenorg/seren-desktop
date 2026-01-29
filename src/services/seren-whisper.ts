// ABOUTME: SerenWhisper API client for speech-to-text transcription.
// ABOUTME: Uses SerenBucks via /agent/api endpoint with multipart support.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/services/auth";

const PUBLISHER_SLUG = "seren-whisper";
const AGENT_API_ENDPOINT = `${apiBase}/agent/api`;

interface TranscriptionResponse {
  text: string;
}

interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  content_type?: string;
  data?: string;
}

interface AgentApiPayload {
  publisher: string;
  path: string;
  method: string;
  content_type: string;
  body: {
    parts: MultipartPart[];
  };
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
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated - please log in");
  }

  const base64Audio = await blobToBase64(audioBlob);

  const payload: AgentApiPayload = {
    publisher: PUBLISHER_SLUG,
    path: "/audio/transcriptions",
    method: "POST",
    content_type: "multipart/form-data",
    body: {
      parts: [
        { name: "model", value: "whisper-1" },
        {
          name: "file",
          filename: `audio.${MIME_EXTENSIONS[mimeType] || "webm"}`,
          content_type: mimeType,
          data: base64Audio,
        },
      ],
    },
  };

  const response = await appFetch(AGENT_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-AGENT-WALLET": "prepaid",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as TranscriptionResponse;
  return result.text;
}
