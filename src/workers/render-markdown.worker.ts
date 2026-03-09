// ABOUTME: Web Worker for off-thread markdown rendering.
// ABOUTME: Processes renderMarkdown + post-processing without blocking the main thread.
/// <reference lib="webworker" />

import { collapseBuildOutput } from "@/lib/build-output";
import { collapseDirectoryListings } from "@/lib/directory-listing";
import { escapeHtml } from "@/lib/escape-html";
import { renderMarkdown } from "@/lib/render-markdown";

interface RenderRequest {
  id: string;
  markdown: string;
}

interface RenderResponse {
  id: string;
  html: string;
  error?: boolean;
}

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  const { id, markdown } = e.data;
  try {
    const html = collapseBuildOutput(
      collapseDirectoryListings(renderMarkdown(markdown)),
    );
    self.postMessage({ id, html } satisfies RenderResponse);
  } catch (err) {
    console.error("[render-markdown.worker] renderMarkdown failed:", err);
    // Return escaped text with newlines preserved so the message is readable.
    const fallback = escapeHtml(markdown).replace(/\n/g, "<br>");
    self.postMessage({
      id,
      html: fallback,
      error: true,
    } satisfies RenderResponse);
  }
};
