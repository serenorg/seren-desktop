// ABOUTME: Critical tests for opening image files in the OS default viewer.
// ABOUTME: Guards shared image extension support and default-app bridge delegation.

import { describe, expect, it, vi } from "vitest";
import { openImageInDefaultViewer } from "@/lib/files/service";
import { isSupportedImageFile } from "@/lib/images/file-types";
import { openPathWithDefaultApp } from "@/lib/tauri-bridge";

vi.mock("@/lib/tauri-bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri-bridge")>(
    "@/lib/tauri-bridge",
  );
  return {
    ...actual,
    openPathWithDefaultApp: vi.fn(),
  };
});

describe("image file opening", () => {
  it("recognizes common default image viewer file types", () => {
    expect(isSupportedImageFile("/Users/me/photo.PNG")).toBe(true);
    expect(isSupportedImageFile("C:\\Users\\me\\Pictures\\scan.tiff")).toBe(
      true,
    );
    expect(isSupportedImageFile("/Users/me/Downloads/live.heic")).toBe(true);
    expect(isSupportedImageFile("/Users/me/Downloads/modern.avif")).toBe(true);
    expect(isSupportedImageFile("/Users/me/notes/image-readme.md")).toBe(false);
  });

  it("delegates image opening to the default-app bridge", async () => {
    await openImageInDefaultViewer("/Users/me/Pictures/photo.jpg");

    expect(openPathWithDefaultApp).toHaveBeenCalledWith(
      "/Users/me/Pictures/photo.jpg",
    );
  });
});
