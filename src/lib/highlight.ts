// ABOUTME: Safe text highlighting helper that returns renderable segments.
// ABOUTME: Avoids innerHTML when marking query terms in search results.

export type HighlightSegment = string | { mark: string };

function uniqueTerms(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of query.split(/\s+/)) {
    const term = raw.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

export function highlightTerms(
  text: string,
  query: string,
): HighlightSegment[] {
  const terms = uniqueTerms(query);
  if (terms.length === 0 || text.length === 0) return [text];

  const lowerText = text.toLowerCase();
  const spans: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    let start = 0;
    while (start < lowerText.length) {
      const index = lowerText.indexOf(lowerTerm, start);
      if (index === -1) break;
      spans.push({ start: index, end: index + lowerTerm.length });
      start = index + Math.max(lowerTerm.length, 1);
    }
  }

  if (spans.length === 0) return [text];

  spans.sort((left, right) =>
    left.start === right.start
      ? left.end - right.end
      : left.start - right.start,
  );
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  const out: HighlightSegment[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) out.push(text.slice(cursor, span.start));
    out.push({ mark: text.slice(span.start, span.end) });
    cursor = span.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
