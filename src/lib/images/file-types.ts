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
