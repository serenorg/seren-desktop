// ABOUTME: Detects verbose build/compile output and provides collapse utilities.
// ABOUTME: Used to suppress noisy cargo/npm/pip output in chat and agent chat panels.

/**
 * Patterns that match a single line of verbose build output.
 * Each regex should match common package-manager progress lines.
 */
const BUILD_LINE_PATTERNS = [
  // Cargo (Rust)
  /^\s*(Compiling|Downloading|Downloaded|Locking|Updating|Fetching|Unpacking|Fresh)\s+\S+/,
  // npm / pnpm / yarn
  /^\s*(added|removed|updated|npm warn|npm info|packages in)\s/i,
  // pip (Python)
  /^\s*(Collecting|Downloading|Installing|Using cached|Requirement already satisfied)\s/i,
  // Go
  /^\s*go: (downloading|extracting|finding)\s/,
];

/** Minimum consecutive matching lines to trigger detection */
const MIN_CONSECUTIVE = 5;

/**
 * Returns true if the text is predominantly verbose build output.
 */
export function isBuildOutput(text: string): boolean {
  const lines = text.split("\n");
  let consecutive = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (BUILD_LINE_PATTERNS.some((p) => p.test(trimmed))) {
      consecutive++;
      if (consecutive >= MIN_CONSECUTIVE) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

/**
 * Returns a one-line summary of build output.
 * Counts matching lines and identifies the build tool.
 */
export function summarizeBuildOutput(text: string): string {
  const lines = text.split("\n");
  let count = 0;
  let tool = "Build";
  for (const line of lines) {
    const trimmed = line.trim();
    if (BUILD_LINE_PATTERNS.some((p) => p.test(trimmed))) {
      count++;
      if (/^\s*Compiling\s/.test(trimmed)) tool = "Cargo build";
      else if (/^\s*Downloading\s/.test(trimmed) && tool === "Build")
        tool = "Download";
      else if (/^\s*(added|npm)\s/i.test(trimmed)) tool = "npm install";
      else if (/^\s*(Collecting|pip)\s/i.test(trimmed)) tool = "pip install";
      else if (/^\s*go:\s/.test(trimmed)) tool = "Go build";
    }
  }
  return `${tool} output (${count} ${count === 1 ? "line" : "lines"})`;
}

/** Decode basic HTML entities for detection in rendered HTML. */
function decodeBasicHtmlEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Post-processes rendered HTML to collapse verbose build output blocks.
 * Wraps detected blocks in native <details><summary> elements.
 */
export function collapseBuildOutput(html: string): string {
  // Handle build output inside <pre><code> blocks (markdown-rendered path)
  const modified = html.replace(
    /(<pre[^>]*><code[^>]*>)([\s\S]*?)(<\/code><\/pre>)/g,
    (match, _open: string, content: string, _close: string) => {
      const decoded = decodeBasicHtmlEntities(content);
      if (isBuildOutput(decoded)) {
        const summary = summarizeBuildOutput(decoded);
        return `<details class="build-output-collapse"><summary style="cursor:pointer;padding:0.25em 0;font-size:0.85em">${summary}</summary>${match}</details>`;
      }
      return match;
    },
  );

  // If we already handled a <pre> block, return
  if (modified !== html) return modified;

  // Handle <br>-separated content (fallback/escaped HTML path)
  if (!/<pre[\s>]/.test(html)) {
    const segments = html.split(/<br\s*\/?>/i);
    if (segments.length >= MIN_CONSECUTIVE) {
      const plainText = segments
        .map((s) => decodeBasicHtmlEntities(s))
        .join("\n");
      if (isBuildOutput(plainText)) {
        const summary = summarizeBuildOutput(plainText);
        return [
          '<details class="build-output-collapse">',
          `<summary style="cursor:pointer;padding:0.25em 0;font-size:0.85em">${summary}</summary>`,
          `<pre style="white-space:pre-wrap;margin:0.5em 0;font-size:12px;color:inherit">${html}</pre>`,
          "</details>",
        ].join("");
      }
    }
  }

  return html;
}
