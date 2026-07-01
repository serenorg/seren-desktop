// ABOUTME: Frontend side of the validation-only typed control bridge.
// ABOUTME: Listens for Rust-emitted commands and returns DOM evidence/results.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { getValidationRuntimeInfo } from "@/services/oauth-callback";

interface ValidationCommand {
  id: string;
  command: string;
  selector?: string;
  value?: string;
  route?: string;
  key?: string;
  timeoutMs?: number;
  native?: boolean;
}

interface ValidationReply {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface NativeCaptureWindow {
  id: string;
  platformId: number;
  pid: number;
  appName: string;
  title: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isFocused: boolean;
  isMinimized: boolean;
  isRecordable: boolean;
}

interface NativeCaptureWindowPreview {
  windowId: string;
  capturedAtMs: number;
  artifactPath: string;
  artifactUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

let installed = false;

export function installValidationControlBridge(): void {
  if (installed || !isTauriRuntime()) return;
  installed = true;

  void getValidationRuntimeInfo()
    .then(async (runtime) => {
      if (!runtime.controlEnabled) {
        installed = false;
        return;
      }

      await listen<ValidationCommand>(
        "validation-control-command",
        async (event) => {
          const command = event.payload;
          const reply: ValidationReply = { id: command.id, ok: true };
          try {
            reply.result = await handleCommand(command);
          } catch (error) {
            reply.ok = false;
            reply.error = error instanceof Error ? error.message : String(error);
          }

          try {
            await invoke("validation_control_reply", { reply });
          } catch (error) {
            console.warn(
              "[ValidationControl] Failed to return command reply",
              error,
            );
          }
        },
      );
      await invoke("validation_control_frontend_ready");
    })
    .catch((error) => {
      installed = false;
      console.warn("[ValidationControl] Failed to install bridge", error);
    });
}

async function handleCommand(command: ValidationCommand): Promise<unknown> {
  switch (command.command) {
    case "navigate":
      return navigate(command.route);
    case "click":
      findElement(command.selector).click();
      return { clicked: command.selector };
    case "fill":
      return fill(command.selector, command.value ?? "");
    case "press":
      return press(command.key ?? command.value ?? "");
    case "waitFor":
      await waitForElement(command.selector, command.timeoutMs ?? 5000);
      return { found: command.selector };
    case "dumpText":
      return dumpText(command.selector);
    case "screenshot":
      return screenshot(command.selector, command.native === true);
    default:
      throw new Error(`Unsupported validation command: ${command.command}`);
  }
}

function navigate(route: string | undefined): { route: string } {
  if (!route) throw new Error("navigate requires route");
  window.history.pushState({}, "", route);
  window.dispatchEvent(new PopStateEvent("popstate"));
  return { route: window.location.href };
}

function fill(selector: string | undefined, value: string): { filled: string } {
  const element = findElement(selector);
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`Element is not fillable: ${selector}`);
  }
  element.focus();
  element.value = value;
  element.dispatchEvent(
    new InputEvent("input", { bubbles: true, data: value }),
  );
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: selector ?? "" };
}

function press(key: string): { pressed: string } {
  if (!key) throw new Error("press requires key");
  const target = document.activeElement ?? document.body;
  for (const type of ["keydown", "keyup"] as const) {
    target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
  }
  return { pressed: key };
}

async function waitForElement(
  selector: string | undefined,
  timeoutMs: number,
): Promise<Element> {
  if (!selector) throw new Error("waitFor requires selector");
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const element = document.querySelector(selector);
    if (element && isElementVisible(element)) return element;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for visible selector: ${selector}`);
}

function findElement(selector: string | undefined): HTMLElement {
  if (!selector) throw new Error("selector is required");
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`No HTMLElement matched selector: ${selector}`);
  }
  return element;
}

function dumpText(selector: string | undefined): unknown {
  const root = selector ? findElement(selector) : document.body;
  const rows: Array<{ selector: string; text: string }> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);

  let index = 0;
  for (
    let current = root as Element | null;
    current;
    current = walker.nextNode() as Element | null
  ) {
    if (!isElementVisible(current)) continue;
    const text = visibleOwnText(current);
    if (!text) continue;
    index += 1;
    rows.push({
      selector: current.id
        ? `#${current.id}`
        : `${current.tagName.toLowerCase()}:nth-visible(${index})`,
      text,
    });
  }

  return {
    selector: selector ?? "body",
    text: rows.map((row) => row.text).join("\n"),
    rows,
    route: window.location.href,
  };
}

async function screenshot(
  selector: string | undefined,
  native: boolean,
): Promise<unknown> {
  if (native) {
    return nativeScreenshot();
  }

  const target = selector ? findElement(selector) : document.documentElement;
  const rect = target.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width || window.innerWidth));
  const height = Math.max(1, Math.ceil(rect.height || window.innerHeight));
  const clone = target.cloneNode(true) as HTMLElement;
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  clone.style.width = `${width}px`;
  clone.style.minHeight = `${height}px`;

  const cssText = collectCssText();
  const serialized = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><style xmlns="http://www.w3.org/1999/xhtml">${escapeStyle(cssText)}</style>${serialized}</foreignObject></svg>`;
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create screenshot canvas context");

  let imageLoadError: string | undefined;
  try {
    const image = await loadImage(dataUrl);
    context.drawImage(image, 0, 0);
  } catch (error) {
    imageLoadError = error instanceof Error ? error.message : String(error);
    drawTextFallback(context, target, width, height, imageLoadError);
  }

  let png: string;
  try {
    png = canvas.toDataURL("image/png");
  } catch (error) {
    return {
      method: "dom-raster",
      rasterSuccess: false,
      taint: true,
      error: error instanceof Error ? error.message : String(error),
      imageCount: target.querySelectorAll("img").length,
      route: window.location.href,
    };
  }

  return {
    method: imageLoadError ? "text-canvas-fallback" : "dom-raster",
    rasterSuccess: !imageLoadError,
    taint: false,
    dataUrl: png,
    width,
    height,
    imageCount: target.querySelectorAll("img").length,
    error: imageLoadError,
    route: window.location.href,
    buildCommit: document.documentElement.dataset.buildCommit,
    buildTimestamp: document.documentElement.dataset.buildTimestamp,
  };
}

async function nativeScreenshot(): Promise<unknown> {
  try {
    const runtime = await getValidationRuntimeInfo();
    if (!runtime.isValidation || runtime.processId <= 0) {
      throw new Error("Native validation capture requires validation runtime info.");
    }

    const windows = await invoke<NativeCaptureWindow[]>(
      "recording_list_capture_windows",
    );
    const captureWindow = selectValidationWindow(windows, runtime.processId);
    if (!captureWindow) {
      throw new Error(
        `No recordable validation window matched process ${runtime.processId}.`,
      );
    }

    const preview = await invoke<NativeCaptureWindowPreview>(
      "recording_capture_window_preview",
      { windowId: captureWindow.id },
    );
    const base64 = await invoke<string>("read_file_base64", {
      path: preview.artifactPath,
    });

    return {
      method: "native-window-preview",
      nativeAvailable: true,
      rasterSuccess: true,
      dataUrl: `data:${preview.mimeType};base64,${base64}`,
      width: preview.width,
      height: preview.height,
      sizeBytes: preview.sizeBytes,
      capturedAtMs: preview.capturedAtMs,
      route: window.location.href,
      window: {
        id: captureWindow.id,
        platformId: captureWindow.platformId,
        pid: captureWindow.pid,
        appName: captureWindow.appName,
        title: captureWindow.title,
        bounds: captureWindow.bounds,
        isFocused: captureWindow.isFocused,
      },
    };
  } catch (error) {
    return {
      method: "native-window-preview",
      nativeAvailable: false,
      rasterSuccess: false,
      error: error instanceof Error ? error.message : String(error),
      route: window.location.href,
    };
  }
}

function selectValidationWindow(
  windows: NativeCaptureWindow[],
  processId: number,
): NativeCaptureWindow | undefined {
  return windows
    .filter((window) => window.pid === processId && window.isRecordable)
    .sort((a, b) => {
      if (a.isFocused !== b.isFocused) return a.isFocused ? -1 : 1;
      const aArea = a.bounds.width * a.bounds.height;
      const bArea = b.bounds.width * b.bounds.height;
      return bArea - aArea;
    })[0];
}

function isElementVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number(style.opacity) === 0
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function visibleOwnText(element: Element): string {
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function collectCssText(): string {
  let css = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      css += Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
    } catch {
      // Cross-origin stylesheets cannot be read; the raster metadata catches
      // rendering failures if the remaining same-origin CSS is insufficient.
    }
  }
  return css;
}

function escapeStyle(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("DOM raster image failed to load"));
    image.src = src;
  });
}

function drawTextFallback(
  context: CanvasRenderingContext2D,
  target: Element,
  width: number,
  height: number,
  reason: string,
): void {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111827";
  context.font = "13px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  context.fillText("Seren validation DOM evidence", 16, 24);
  context.fillStyle = "#6b7280";
  context.fillText(`DOM raster fallback: ${reason}`, 16, 44);
  context.fillText(window.location.href, 16, 64);

  context.fillStyle = "#111827";
  const text = collectVisibleText(target).slice(0, 80);
  let y = 92;
  for (const line of text) {
    if (y > height - 16) break;
    context.fillText(line.slice(0, 160), 16, y);
    y += 18;
  }
}

function collectVisibleText(target: Element): string[] {
  const lines: string[] = [];
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT);
  for (
    let current = target as Element | null;
    current;
    current = walker.nextNode() as Element | null
  ) {
    if (!isElementVisible(current)) continue;
    const text = visibleOwnText(current);
    if (text) lines.push(text);
  }
  return lines;
}
