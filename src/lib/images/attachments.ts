// ABOUTME: Image attachment utilities for picking, reading, and validating images.
// ABOUTME: Provides file dialog integration and base64 conversion for chat image attachments.

import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import type { ImageAttachment } from "@/lib/providers/types";

const SUPPORTED_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function getExtension(path: string): string {
  const parts = path.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

function getFileName(path: string): string {
  const parts = path.split("/");
  const winParts = parts[parts.length - 1].split("\\");
  return winParts[winParts.length - 1];
}

/**
 * Open a file dialog to pick one or more images.
 * Returns file paths selected by the user.
 */
export async function pickImageFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    title: "Attach Images",
    filters: [
      {
        name: "Images",
        extensions: SUPPORTED_EXTENSIONS,
      },
    ],
  });

  if (!selected) return [];
  if (typeof selected === "string") return [selected];
  return selected;
}

/**
 * Read an image file and convert it to an ImageAttachment.
 */
export async function readImageAttachment(
  path: string,
): Promise<ImageAttachment> {
  const ext = getExtension(path);
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(`Unsupported image format: .${ext}`);
  }

  const bytes = await readFile(path);
  if (bytes.length > MAX_FILE_SIZE) {
    throw new Error(
      `Image too large: ${(bytes.length / 1024 / 1024).toFixed(1)}MB (max 20MB)`,
    );
  }

  // Convert Uint8Array to base64
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return {
    name: getFileName(path),
    mimeType,
    base64,
  };
}

/**
 * Pick images via file dialog and return them as attachments.
 */
export async function pickAndReadImages(): Promise<ImageAttachment[]> {
  const paths = await pickImageFiles();
  const attachments: ImageAttachment[] = [];

  for (const path of paths) {
    try {
      const attachment = await readImageAttachment(path);
      attachments.push(attachment);
    } catch (error) {
      console.warn(`[attachments] Failed to read image ${path}:`, error);
    }
  }

  return attachments;
}

/**
 * Build a data URL from an ImageAttachment.
 */
export function toDataUrl(attachment: ImageAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.base64}`;
}
