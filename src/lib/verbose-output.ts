// ABOUTME: Catch-all collapser for large output blocks not caught by specific detectors.
// ABOUTME: Collapses any block exceeding line/character thresholds into a details element.

/** Minimum number of lines to trigger collapse */
const MIN_LINES = 20;

/** Minimum character count to trigger collapse */
const MIN_CHARS = 2000;

/** Decode basic HTML entities for measurement. */
function decodeBasicHtmlEntities(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Generates a summary label for a large output block.
 */
function summarizeLargeOutput(text: string): string {
  const lineCount = text.split("\n").filter((l) => l.trim()).length;
  return `Large output (${lineCount} lines)`;
}

/**
 * Post-processes rendered HTML to collapse large output blocks that weren't
 * already collapsed by the directory-listing or build-output detectors.
 *
 * This is a catch-all — it should be called LAST in the collapse chain.
 */
export function collapseVerboseOutput(html: string): string {
  // Skip if already collapsed by a specific detector
  if (
    html.includes("dir-listing-collapse") ||
    html.includes("build-output-collapse")
  ) {
    return html;
  }

  // Handle large content inside <pre><code> blocks
  const modified = html.replace(
    /(<pre[^>]*><code[^>]*>)([\s\S]*?)(<\/code><\/pre>)/g,
    (match, _open: string, content: string, _close: string) => {
      const decoded = decodeBasicHtmlEntities(content);
      const lines = decoded.split("\n").filter((l) => l.trim());
      if (lines.length >= MIN_LINES || decoded.length >= MIN_CHARS) {
        const summary = summarizeLargeOutput(decoded);
        return `<details class="verbose-output-collapse"><summary style="cursor:pointer;padding:0.25em 0;font-size:0.85em">${summary}</summary>${match}</details>`;
      }
      return match;
    },
  );

  if (modified !== html) return modified;

  // Handle <br>-separated content
  if (!/<pre[\s>]/.test(html)) {
    const segments = html.split(/<br\s*\/?>/i);
    const plainText = segments
      .map((s) => decodeBasicHtmlEntities(s))
      .join("\n");
    const nonEmptyLines = plainText.split("\n").filter((l) => l.trim());

    if (
      nonEmptyLines.length >= MIN_LINES ||
      plainText.length >= MIN_CHARS
    ) {
      const summary = summarizeLargeOutput(plainText);
      return [
        '<details class="verbose-output-collapse">',
        `<summary style="cursor:pointer;padding:0.25em 0;font-size:0.85em">${summary}</summary>`,
        `<pre style="white-space:pre-wrap;margin:0.5em 0;font-size:12px;color:inherit">${html}</pre>`,
        "</details>",
      ].join("");
    }
  }

  return html;
}
