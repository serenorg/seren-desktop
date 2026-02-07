// ABOUTME: Image attachment utilities for picking, reading, and validating images.
// ABOUTME: Provides file dialog integration, base64 conversion, and resizing for chat image attachments.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ImageAttachment } from "@/lib/providers/types";

const SUPPORTED_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const MAX_BASE64_SIZE = 27 * 1024 * 1024; // ~20MB file = ~27MB base64
const MAX_IMAGE_DIMENSION = 1024;

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
 * Resize an image to fit within maxDim on both sides using canvas.
 * Returns the resized base64 and updated mimeType.
 * GIF images are not resized (may be animated).
 */
function resizeImage(
  base64: string,
  mimeType: string,
  maxDim: number,
): Promise<{ base64: string; mimeType: string }> {
  if (mimeType === "image/gif") {
    return Promise.resolve({ base64, mimeType });
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;

      if (width <= maxDim && height <= maxDim) {
        resolve({ base64, mimeType });
        return;
      }

      if (width > height) {
        height = Math.round(height * (maxDim / width));
        width = maxDim;
      } else {
        width = Math.round(width * (maxDim / height));
        height = maxDim;
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to create canvas context"));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);

      // Keep PNG for transparency, JPEG for everything else
      const outputMime = mimeType === "image/png" ? "image/png" : "image/jpeg";
      const quality = outputMime === "image/jpeg" ? 0.85 : undefined;
      const dataUrl = canvas.toDataURL(outputMime, quality);
      const resizedBase64 = dataUrl.split(",")[1];
      resolve({ base64: resizedBase64, mimeType: outputMime });
    };
    img.onerror = () => reject(new Error("Failed to load image for resizing"));
    img.src = `data:${mimeType};base64,${base64}`;
  });
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
 * Read an image file, resize it, and convert it to an ImageAttachment.
 */
export async function readImageAttachment(
  path: string,
): Promise<ImageAttachment> {
  const ext = getExtension(path);
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(`Unsupported image format: .${ext}`);
  }

  const base64 = await invoke<string>("read_file_base64", { path });
  if (base64.length > MAX_BASE64_SIZE) {
    throw new Error("Image too large (max 20MB)");
  }

  const resized = await resizeImage(base64, mimeType, MAX_IMAGE_DIMENSION);

  return {
    name: getFileName(path),
    mimeType: resized.mimeType,
    base64: resized.base64,
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
