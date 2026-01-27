import hljs from "highlight.js";
import { marked, type Tokens } from "marked";
import { escapeHtml } from "@/lib/escape-html";
import "./render-markdown.css";

// Custom renderer for markdown
const renderer = new marked.Renderer();

// Override html token to escape HTML
renderer.html = (token: Tokens.HTML | Tokens.Tag): string => {
  return escapeHtml(token.text);
};

// Override code blocks to add syntax highlighting and copy button
renderer.code = (token: Tokens.Code): string => {
  const { text, lang } = token;
  let highlighted: string;

  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(text, { language: lang }).value;
  } else {
    highlighted = hljs.highlightAuto(text).value;
  }

  const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  const escapedCode = escapeHtml(text);
  const langLabel = lang ? escapeHtml(lang) : "text";

  return `<div class="code-block-wrapper">
    <div class="code-block-header">
      <span class="code-block-lang">${langLabel}</span>
      <button class="code-copy-btn" data-code="${escapedCode.replace(/"/g, "&quot;")}" title="Copy code">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>
          <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
        </svg>
        Copy
      </button>
    </div>
    <pre><code${langClass}>${highlighted}</code></pre>
  </div>`;
};

marked.setOptions({
  gfm: true,
  breaks: true,
  renderer,
});

export function renderMarkdown(markdown: string): string {
  const result = marked.parse(markdown);
  return typeof result === "string" ? result : "";
}
