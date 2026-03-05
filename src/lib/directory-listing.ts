// ABOUTME: Detects verbose file-listing output and provides collapse utilities.
// ABOUTME: Catches ls -l, find, path listings, and traversal errors in chat panels.

/** Unix ls -l permission format: drwxr-xr-x, -rw-r--r--, etc. */
const LS_LINE = /^[dlcbps-][rwxsStT-]{9}\s/;

/** Total line header from ls -l output */
const TOTAL_LINE = /^total \d+$/;

/** Absolute Unix path: starts with / followed by at least one path segment */
const UNIX_PATH = /^\/[\w.@~+-]/;

/** Absolute Windows path: C:\ or similar */
const WIN_PATH = /^[A-Za-z]:[/\\]/;

/** Relative path with at least two segments: src/lib/file.ts, artifacts/bot/script.py */
const RELATIVE_PATH = /^[\w.@~+-][\w.@~+-]*\/[\w.@~+-]/;

/** Path followed by an error: /path/to/dir: Operation not permitted (os error 1) */
const PATH_ERROR =
  /^\/[\w.@~+-].*:\s+(Operation not permitted|Permission denied|No such file|Is a directory|Not a directory)/;

/** find-style error: find: '/path': Permission denied */
const FIND_ERROR = /^(find|ls|stat):\s/;

/** tree-style lines: ├── file.txt, └── dir/, │ */
const TREE_LINE = /^[│├└─\s]{2,}/;

/** Minimum consecutive matching lines to trigger detection */
const MIN_CONSECUTIVE = 5;

/** Returns true if a line looks like file-listing output. */
function isListingLine(trimmed: string): boolean {
  return (
    LS_LINE.test(trimmed) ||
    TOTAL_LINE.test(trimmed) ||
    PATH_ERROR.test(trimmed) ||
    FIND_ERROR.test(trimmed) ||
    TREE_LINE.test(trimmed) ||
    UNIX_PATH.test(trimmed) ||
    WIN_PATH.test(trimmed) ||
    RELATIVE_PATH.test(trimmed)
  );
}

/**
 * Returns true if the text is predominantly a file listing.
 * Detects `ls -l`, `find`, bare path listings, and traversal errors.
 */
export function isDirectoryListing(text: string): boolean {
  const lines = text.split("\n");
  let consecutive = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isListingLine(trimmed)) {
      consecutive++;
      if (consecutive >= MIN_CONSECUTIVE) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

/**
 * Returns a one-line summary of a file listing.
 * Counts lines matching any listing pattern.
 */
export function summarizeDirectoryListing(text: string): string {
  const lines = text.split("\n");
  let count = 0;
  let hasErrors = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (isListingLine(trimmed)) {
      count++;
      if (
        !hasErrors &&
        (PATH_ERROR.test(trimmed) || FIND_ERROR.test(trimmed))
      ) {
        hasErrors = true;
      }
    }
  }
  if (hasErrors) {
    return `File listing with errors (${count} ${count === 1 ? "line" : "lines"})`;
  }
  return `File listing (${count} ${count === 1 ? "entry" : "entries"})`;
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
 * Post-processes rendered HTML to collapse file listing blocks.
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
