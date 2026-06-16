// ABOUTME: Critical tests for opening image and PDF files in the editor viewers.
// ABOUTME: Guards binary tabs opening without a text read and bridge delegation.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isPdfFile } from "@/lib/files/file-types";
import {
  openFileInTab,
  openImageInDefaultViewer,
  readFileBytes,
  readImageAsDataUrl,
} from "@/lib/files/service";
import {
  imageMimeType,
  isSupportedImageFile,
} from "@/lib/images/file-types";
import {
  openPathWithDefaultApp,
  readFile,
  readFileBase64,
} from "@/lib/tauri-bridge";
import { closeAllTabs, tabsState } from "@/stores/tabs";

vi.mock("@/lib/tauri-bridge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri-bridge")>(
    "@/lib/tauri-bridge",
  );
  return {
    ...actual,
    openPathWithDefaultApp: vi.fn(),
    readFile: vi.fn(),
    readFileBase64: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  closeAllTabs();
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

  it("maps supported image extensions to data-URL MIME types", () => {
    expect(imageMimeType("/Users/me/photo.PNG")).toBe("image/png");
    expect(imageMimeType("/Users/me/photo.jpeg")).toBe("image/jpeg");
    expect(imageMimeType("/Users/me/photo.jpe")).toBe("image/jpeg");
    expect(imageMimeType("/Users/me/icon.svg")).toBe("image/svg+xml");
    expect(imageMimeType("C:\\Users\\me\\live.HEIC")).toBe("image/heic");
    expect(imageMimeType("/Users/me/notes/readme.md")).toBeNull();
  });

  it("builds a data URL for an image from its base64 bytes", async () => {
    vi.mocked(readFileBase64).mockResolvedValue("QUJD");

    const url = await readImageAsDataUrl("/Users/me/Pictures/photo.png");

    expect(readFileBase64).toHaveBeenCalledWith("/Users/me/Pictures/photo.png");
    expect(url).toBe("data:image/png;base64,QUJD");
  });

  it("opens image tabs without reading them as text (would throw on binary)", async () => {
    // read_file does a UTF-8 read and throws on binary data; the fix must not
    // call it, or the tab never opens and the click silently does nothing.
    vi.mocked(readFile).mockRejectedValue(
      new Error("stream did not contain valid UTF-8"),
    );

    await expect(
      openFileInTab("/Users/me/Pictures/photo.png"),
    ).resolves.toBeUndefined();

    expect(readFile).not.toHaveBeenCalled();
    expect(
      tabsState.tabs.some((t) => t.filePath === "/Users/me/Pictures/photo.png"),
    ).toBe(true);
  });

  it("reads non-image files as text content", async () => {
    vi.mocked(readFile).mockResolvedValue("hello world");

    await openFileInTab("/Users/me/notes/readme.md");

    expect(readFile).toHaveBeenCalledWith("/Users/me/notes/readme.md");
    const tab = tabsState.tabs.find(
      (t) => t.filePath === "/Users/me/notes/readme.md",
    );
    expect(tab?.content).toBe("hello world");
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

describe("pdf file opening", () => {
  it("detects pdf paths case-insensitively", () => {
    expect(isPdfFile("/Users/me/docs/report.pdf")).toBe(true);
    expect(isPdfFile("C:\\Users\\me\\Report.PDF")).toBe(true);
    expect(isPdfFile("/Users/me/notes/readme.md")).toBe(false);
  });

  it("opens pdf tabs without reading them as text (would throw on binary)", async () => {
    vi.mocked(readFile).mockRejectedValue(
      new Error("stream did not contain valid UTF-8"),
    );

    await expect(
      openFileInTab("/Users/me/docs/report.pdf"),
    ).resolves.toBeUndefined();

    expect(readFile).not.toHaveBeenCalled();
    expect(
      tabsState.tabs.some((t) => t.filePath === "/Users/me/docs/report.pdf"),
    ).toBe(true);
  });

  it("reads file bytes from base64 for binary viewers", async () => {
    // "ABC" -> base64 "QUJD"
    vi.mocked(readFileBase64).mockResolvedValue("QUJD");

    const bytes = await readFileBytes("/Users/me/docs/report.pdf");

    expect(readFileBase64).toHaveBeenCalledWith("/Users/me/docs/report.pdf");
    expect(Array.from(bytes)).toEqual([65, 66, 67]);
  });
});
