// ABOUTME: Web Worker for off-thread markdown rendering.
// ABOUTME: Processes renderMarkdown calls without blocking the main thread.
/// <reference lib="webworker" />

import { renderMarkdown } from "@/lib/render-markdown";

interface RenderRequest {
  id: string;
  markdown: string;
}

interface RenderResponse {
  id: string;
  html: string;
}

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  const { id, markdown } = e.data;
  const html = renderMarkdown(markdown);
  const response: RenderResponse = { id, html };
  self.postMessage(response);
};
