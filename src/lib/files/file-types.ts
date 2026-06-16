// ABOUTME: Pure file-type predicates for routing files to editor viewers.
// ABOUTME: Free of I/O so it is safe to import where the files service is mocked.

/**
 * Whether a path is a PDF rendered by the in-app PDF viewer rather than the
 * text editor.
 */
export function isPdfFile(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}
