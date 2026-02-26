// ABOUTME: File attachment utilities for picking, reading, and validating attachments.
// ABOUTME: Supports images (with resizing), PDFs, and text/code files for chat and agent inputs.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Attachment } from "@/lib/providers/types";

const MAX_BASE64_SIZE = 27 * 1024 * 1024; // ~20MB file = ~27MB base64
const MAX_VIDEO_BASE64_SIZE = 267 * 1024 * 1024; // ~200MB file = ~267MB base64
const MAX_IMAGE_DIMENSION = 1024;

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];

const DOCUMENT_EXTENSIONS = ["pdf"];

const DOCREADER_EXTENSIONS = ["doc", "docx", "xls", "xlsx", "ppt", "pptx"];

const VIDEO_EXTENSIONS = ["mp4", "mov", "webm", "avi", "mkv"];

const TEXT_EXTENSIONS = [
  // Plain text & markup
  "txt",
  "md",
  "csv",
  "json",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "log",
  // Web
  "html",
  "htm",
  "css",
  "svg",
  // Programming languages
  "js",
  "ts",
  "jsx",
  "tsx",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "rb",
  "swift",
  "kt",
  "r",
  "lua",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "sql",
  "graphql",
  "proto",
];

const ALL_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
  ...DOCREADER_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...TEXT_EXTENSIONS,
];

const MIME_TYPES: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  // Documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Video
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  // Text & markup
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  log: "text/plain",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  // Code
  js: "text/javascript",
  ts: "text/typescript",
  jsx: "text/javascript",
  tsx: "text/typescript",
  py: "text/x-python",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  c: "text/x-c",
  cpp: "text/x-c++",
  h: "text/x-c",
  hpp: "text/x-c++",
  cs: "text/x-csharp",
  rb: "text/x-ruby",
  swift: "text/x-swift",
  kt: "text/x-kotlin",
  r: "text/x-r",
  lua: "text/x-lua",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  zsh: "text/x-shellscript",
  ps1: "text/x-powershell",
  sql: "text/x-sql",
  graphql: "text/x-graphql",
  proto: "text/x-protobuf",
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

/** Check whether a MIME type represents an image. */
export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/** Check whether a MIME type requires docreader processing (PDFs and Office documents). */
export function isDocreaderMime(mimeType: string): boolean {
  return (
    mimeType === "application/pdf" ||
    mimeType === "application/msword" ||
    mimeType.startsWith("application/vnd.openxmlformats-officedocument") ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "application/vnd.ms-powerpoint" ||
    mimeType.startsWith("video/")
  );
}

/** Check whether a MIME type represents a text/code file. */
export function isTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  );
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
 * Open a file dialog to pick one or more files.
 * Accepts images, PDFs, and text/code files.
 */
export async function pickFiles(): Promise<string[]> {
  console.log("[attachments] pickFiles called, opening dialog...");
  console.log("[attachments] Supported extensions:", ALL_EXTENSIONS.join(", "));
  try {
    // Ensure the dialog module is available
    if (typeof open !== "function") {
      console.error("[attachments] Dialog 'open' function not available");
      throw new Error(
        "File dialog not available - dialog plugin may not be initialized",
      );
    }

    console.log("[attachments] Calling open() with filters...");
    const selected = await open({
      multiple: true,
      title: "Attach Files",
      filters: [
        {
          name: "All Supported",
          extensions: ALL_EXTENSIONS,
        },
        {
          name: "Images",
          extensions: IMAGE_EXTENSIONS,
        },
        {
          name: "Documents",
          extensions: DOCUMENT_EXTENSIONS,
        },
        {
          name: "Office Documents",
          extensions: DOCREADER_EXTENSIONS,
        },
        {
          name: "Video",
          extensions: VIDEO_EXTENSIONS,
        },
        {
          name: "Text & Code",
          extensions: TEXT_EXTENSIONS,
        },
      ],
    });

    console.log("[attachments] pickFiles dialog returned:", selected);
    if (!selected) {
      console.log(
        "[attachments] No files selected (dialog cancelled or empty selection)",
      );
      return [];
    }
    if (typeof selected === "string") {
      console.log("[attachments] Single file selected:", selected);
      return [selected];
    }
    console.log("[attachments] Multiple files selected:", selected.length);
    return selected;
  } catch (error) {
    console.error("[attachments] pickFiles error:", error);
    // Re-throw with more context
    if (error instanceof Error) {
      throw new Error(`Failed to open file picker: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Read a file and convert it to an Attachment.
 * Images are resized; PDFs and text files are read as-is.
 */
export async function readAttachment(path: string): Promise<Attachment> {
  const ext = getExtension(path);
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) {
    throw new Error(`Unsupported file format: .${ext}`);
  }

  const base64 = await invoke<string>("read_file_base64", { path });
  const sizeLimit = mimeType.startsWith("video/")
    ? MAX_VIDEO_BASE64_SIZE
    : MAX_BASE64_SIZE;
  const maxLabel = mimeType.startsWith("video/") ? "200MB" : "20MB";
  if (base64.length > sizeLimit) {
    throw new Error(`File too large (max ${maxLabel})`);
  }

  // Only resize raster images (not SVGs, PDFs, or text files)
  if (isImageMime(mimeType) && mimeType !== "image/svg+xml") {
    const resized = await resizeImage(base64, mimeType, MAX_IMAGE_DIMENSION);
    return {
      name: getFileName(path),
      mimeType: resized.mimeType,
      base64: resized.base64,
    };
  }

  return {
    name: getFileName(path),
    mimeType,
    base64,
  };
}

/**
 * Pick files via dialog and return them as attachments.
 */
export async function pickAndReadAttachments(): Promise<Attachment[]> {
  const paths = await pickFiles();
  const attachments: Attachment[] = [];

  for (const path of paths) {
    try {
      const attachment = await readAttachment(path);
      attachments.push(attachment);
    } catch (error) {
      console.warn(`[attachments] Failed to read file ${path}:`, error);
    }
  }

  return attachments;
}

// --- Backward-compatible aliases ---

/** @deprecated Use pickFiles instead */
export const pickImageFiles = pickFiles;

/** @deprecated Use readAttachment instead */
export const readImageAttachment = readAttachment;

/** @deprecated Use pickAndReadAttachments instead */
export const pickAndReadImages = pickAndReadAttachments;

/**
 * Build a data URL from an Attachment.
 */
export function toDataUrl(attachment: Attachment): string {
  return `data:${attachment.mimeType};base64,${attachment.base64}`;
}
