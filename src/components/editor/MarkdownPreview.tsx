// ABOUTME: Markdown preview pane for rendering markdown files.
// ABOUTME: Displays rendered HTML with syntax highlighting for code blocks.

/* eslint-disable solid/no-innerhtml */
import { Component, createMemo } from "solid-js";
import { renderMarkdown } from "@/lib/render-markdown";
import "highlight.js/styles/github-dark.css";
import "./MarkdownPreview.css";

interface MarkdownPreviewProps {
  content: string;
}

export const MarkdownPreview: Component<MarkdownPreviewProps> = (props) => {
  const renderedHtml = createMemo(() => renderMarkdown(props.content));

  return (
    <div class="markdown-preview">
      <div class="markdown-preview-header">
        <span class="preview-label">Preview</span>
      </div>
      <div class="markdown-preview-content" innerHTML={renderedHtml()} />
    </div>
  );
};
