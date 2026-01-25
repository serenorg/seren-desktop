import { marked } from "marked";
import hljs from "highlight.js";
import { escapeHtml } from "@/lib/escape-html";

const renderer = new marked.Renderer();
renderer.html = (html: string) => escapeHtml(html);

marked.setOptions({
  gfm: true,
  breaks: true,
  mangle: false,
  headerIds: false,
  renderer,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  },
});

export function renderMarkdown(markdown: string): string {
  return marked.parse(markdown)?.toString() ?? "";
}
