import { marked, type Tokens } from "marked";
import hljs from "highlight.js";
import { escapeHtml } from "@/lib/escape-html";

// Custom renderer for markdown
const renderer = new marked.Renderer();

// Override html token to escape HTML
renderer.html = (token: Tokens.HTML | Tokens.Tag): string => {
  return escapeHtml(token.text);
};

// Override code blocks to add syntax highlighting
renderer.code = (token: Tokens.Code): string => {
  const { text, lang } = token;
  let highlighted: string;

  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(text, { language: lang }).value;
  } else {
    highlighted = hljs.highlightAuto(text).value;
  }

  const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre><code${langClass}>${highlighted}</code></pre>`;
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
