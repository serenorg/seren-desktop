// ABOUTME: Critical tests for opening image files in the OS default viewer.
// ABOUTME: Guards shared image extension support and default-app bridge delegation.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("registers the browser-local default-app opener fallback", () => {
    const dialogsSource = readFileSync(
      resolve("bin/browser-local/dialogs.mjs"),
      "utf-8",
    );
    const desktopSource = readFileSync(
      resolve("bin/seren-desktop.mjs"),
      "utf-8",
    );

    expect(dialogsSource).toContain(
      "export async function openPathWithDefaultApp",
    );
    expect(dialogsSource).toContain('execStrict("open", [path])');
    expect(dialogsSource).toContain('execStrict("xdg-open", [path])');
    expect(dialogsSource).toContain("Start-Process -LiteralPath $args[0]");
    expect(desktopSource).toContain(
      'registerHandler("open_path_with_default_app", openPathWithDefaultApp)',
    );
  });
});
