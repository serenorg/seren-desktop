// ABOUTME: Detects Unix directory listing output and provides collapse utilities.
// ABOUTME: Used to suppress verbose ls output in chat and agent chat panels.

/** Unix ls -l permission format: drwxr-xr-x, -rw-r--r--, etc. */
const LS_LINE = /^[dlcbps-][rwxsStT-]{9}\s/;

/** Total line header from ls -l output */
const TOTAL_LINE = /^total \d+$/;

/** Minimum consecutive matching lines to trigger detection */
const MIN_CONSECUTIVE = 5;

/**
 * Returns true if the text is predominantly a Unix directory listing.
 * Detects `ls -l` style output with permission bits.
 */
export function isDirectoryListing(text: string): boolean {
  const lines = text.split("\n");
  let consecutive = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (LS_LINE.test(trimmed) || TOTAL_LINE.test(trimmed)) {
      consecutive++;
      if (consecutive >= MIN_CONSECUTIVE) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

/**
 * Returns a one-line summary of a directory listing.
 * Counts lines matching ls -l format.
 */
export function summarizeDirectoryListing(text: string): string {
  const lines = text.split("\n");
  let count = 0;
  for (const line of lines) {
    if (LS_LINE.test(line.trim())) count++;
  }
  return `Directory listing (${count} ${count === 1 ? "entry" : "entries"})`;
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
 * Post-processes rendered HTML to collapse directory listing blocks.
 * Wraps detected blocks in native <details><summary> elements.
 */
export function collapseDirectoryListings(html: string): string {
  // Handle directory listings inside <pre><code> blocks (markdown-rendered path)
  const modified = html.replace(
    /(<pre[^>]*><code[^>]*>)([\s\S]*?)(<\/code><\/pre>)/g,
    (match, _open: string, content: string, _close: string) => {
      const decoded = decodeBasicHtmlEntities(content);
      if (isDirectoryListing(decoded)) {
        const summary = summarizeDirectoryListing(decoded);
        return `<details class="dir-listing-collapse"><summary style="cursor:pointer;padding:0.25em 0;font-size:0.85em">${summary}</summary>${match}</details>`;
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
      if (isDirectoryListing(plainText)) {
        const summary = summarizeDirectoryListing(plainText);
        return [
          '<details class="dir-listing-collapse">',
          `<summary style="cursor:pointer;padding:0.25em 0;font-size:0.85em">${summary}</summary>`,
          `<pre style="white-space:pre-wrap;margin:0.5em 0;font-size:12px;color:inherit">${html}</pre>`,
          "</details>",
        ].join("");
      }
    }
  }

  return html;
}
