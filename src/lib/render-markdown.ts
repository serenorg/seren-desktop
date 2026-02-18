// ABOUTME: Converts markdown text to HTML for display in agent chat messages.
// ABOUTME: Handles code highlighting, link safety, and Codex unfenced-code normalization.
import hljs from "highlight.js";
import { marked, type Tokens } from "marked";
import { escapeHtml } from "@/lib/escape-html";

// Custom renderer for markdown
const renderer = new marked.Renderer();

// Override html token to escape HTML
renderer.html = (token: Tokens.HTML | Tokens.Tag): string => {
  return escapeHtml(token.text);
};

// Override links to open in external browser via event delegation
renderer.link = (token: Tokens.Link): string => {
  const href = token.href;
  if (!href || /^(javascript|data|vbscript):/i.test(href)) {
    return escapeHtml(token.text);
  }
  const safeHref = escapeHtml(href);
  const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
  return `<a href="${safeHref}"${title} class="external-link" data-external-url="${safeHref}">${escapeHtml(token.text)}</a>`;
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

/**
 * Returns true when a line (already trimmed) looks like TypeScript/JavaScript
 * code rather than prose. Used by wrapCodeIslands to detect unfenced code.
 */
export function isCodeLine(trimmed: string, inCComment: boolean): boolean {
  if (!trimmed) return false;

  // C-style comment openers (/** or /*)
  if (/^\/\*\*?/.test(trimmed)) return true;

  // C-style comment closers and continuations – only inside an open comment
  if (inCComment && /^(\*\/|\*\s)/.test(trimmed)) return true;

  // TypeScript/JS typed declarations
  if (/^(export\s+)?(type|interface)\s+\w/.test(trimmed)) return true;
  if (/^(export\s+)?(abstract\s+)?class\s+\w/.test(trimmed)) return true;
  if (/^(export\s+)?(async\s+)?function\s+\w/.test(trimmed)) return true;
  if (/^(export\s+)?(const|let|var)\s+[\w_$]/.test(trimmed)) return true;
  if (/^(export\s+)?enum\s+\w/.test(trimmed)) return true;
  if (/^import\s+(type\s+)?(\{|\*|[\w_$])/.test(trimmed)) return true;

  // Lines ending with ; — strong code signal. Exclude obvious prose sentences
  // (capital letter followed by a lowercase word, e.g. "This returns a value;")
  if (/;\s*$/.test(trimmed) && !/^[A-Z][a-z]+\s+[a-z]/.test(trimmed))
    return true;

  // Closing brace/bracket lines common in TypeScript
  if (/^\}[;,]?\s*$/.test(trimmed)) return true;

  // HTTP/OpenAPI status-code type entries: `404: unknown;`
  if (/^\d{3,4}:\s+\w/.test(trimmed)) return true;

  return false;
}

/**
 * Wrap consecutive "code island" lines outside existing fences in a
 * ```typescript fence. Codex frequently outputs TypeScript type definitions
 * and JSDoc comments as plain text without code fences, causing * lines to
 * render as markdown bullets and declarations to appear as unstyled paragraphs.
 *
 * A run of 2+ consecutive code-like lines is wrapped. Single isolated lines
 * are left alone to avoid false positives.
 */
export function wrapCodeIslands(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let inCComment = false;
  const codeBuf: string[] = [];
  const blankBuf: string[] = [];

  const flush = () => {
    if (codeBuf.length >= 2) {
      // Trim trailing blank lines out of the code block into blankBuf
      while (codeBuf.length > 0 && !codeBuf[codeBuf.length - 1].trim()) {
        blankBuf.unshift(codeBuf.pop() as string);
      }
      if (codeBuf.length >= 2) {
        out.push("```typescript", ...codeBuf, "```");
        codeBuf.length = 0;
        return;
      }
    }
    out.push(...codeBuf);
    codeBuf.length = 0;
  };

  for (const line of lines) {
    const t = line.trim();

    // Toggle existing fence state
    if (/^(`{3,}|~{3,})/.test(t)) {
      if (!inFence) {
        flush();
        out.push(...blankBuf);
        blankBuf.length = 0;
      }
      inFence = !inFence;
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    if (!t) {
      blankBuf.push(line);
      continue;
    }

    // Track C-style comment blocks outside fences.
    // Open BEFORE isCodeLine so /** lines are seen as inCComment=true.
    // Close AFTER isCodeLine so */ lines are still seen as inCComment=true.
    if (/\/\*\*?/.test(t)) inCComment = true;

    if (isCodeLine(t, inCComment)) {
      codeBuf.push(...blankBuf, line);
      blankBuf.length = 0;
    } else {
      flush();
      out.push(...blankBuf, line);
      blankBuf.length = 0;
    }

    if (/\*\//.test(t)) inCComment = false;
  }

  flush();
  out.push(...blankBuf);
  return out.join("\n");
}

/**
 * Ensure ATX headings (## heading) and fenced code blocks (```) are preceded
 * by a blank line. With `breaks: true`, marked can fail to interrupt an
 * in-progress paragraph at these block-level elements when no blank line
 * separates them — common in Codex/agent output that omits blank lines.
 *
 * Also detects unfenced TypeScript/JSDoc "code islands" and wraps them in
 * fenced code blocks so they render with syntax highlighting rather than
 * as markdown bullets and plain paragraphs.
 */
function normalizeAgentMarkdown(markdown: string): string {
  let result = markdown.replace(/([^\n])\n(#{1,6} )/g, "$1\n\n$2");
  result = result.replace(/([^\n])\n(`{3,}|~{3,})/g, "$1\n\n$2");
  return wrapCodeIslands(result);
}

export function renderMarkdown(markdown: string): string {
  const result = marked.parse(normalizeAgentMarkdown(markdown));
  return typeof result === "string" ? result : "";
}

const URL_REGEX = /https?:\/\/[^\s<>"'`)\]]+/g;

/**
 * Escapes HTML and converts plain URLs to clickable links.
 * Use for user messages where markdown rendering is not applied.
 */
export function escapeHtmlWithLinks(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(URL_REGEX, (url) => {
    const safeUrl = escapeHtml(url);
    return `<a href="${safeUrl}" class="external-link" data-external-url="${safeUrl}">${safeUrl}</a>`;
  });
}
