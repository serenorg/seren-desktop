// ABOUTME: Shared image file type detection for editor image previews.
// ABOUTME: Keeps image tab routing consistent across editor surfaces.

export const SUPPORTED_IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "gif",
  "svg",
  "webp",
  "bmp",
  "dib",
  "ico",
  "cur",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
] as const;

const SUPPORTED_IMAGE_EXTENSION_SET = new Set<string>(
  SUPPORTED_IMAGE_EXTENSIONS,
);

function fileNameFromPath(path: string): string {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
}

export function imageFileExtension(path: string): string | null {
  const fileName = fileNameFromPath(path);
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1).toLowerCase();
}

export function isSupportedImageFile(path: string): boolean {
  const extension = imageFileExtension(path);
  return extension !== null && SUPPORTED_IMAGE_EXTENSION_SET.has(extension);
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  dib: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  avif: "image/avif",
};

/**
 * Resolve the MIME type used to build a `data:` URL for an image preview.
 * Returns null for paths that are not supported image files.
 */
export function imageMimeType(path: string): string | null {
  const extension = imageFileExtension(path);
  if (extension === null) return null;
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}
