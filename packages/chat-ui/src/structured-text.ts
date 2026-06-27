// ABOUTME: Markdown-like structured text parsing helpers for chat transcripts.
// ABOUTME: Stays framework-free so parser behavior can be tested without JSX.

export type ChatStructuredTextBlock =
  | {
      kind: "paragraph";
      text: string;
    }
  | {
      kind: "heading";
      level: 1 | 2 | 3;
      text: string;
    }
  | {
      kind: "unordered-list";
      items: string[];
    }
  | {
      kind: "ordered-list";
      items: string[];
    }
  | {
      kind: "quote";
      text: string;
    }
  | {
      kind: "code";
      language: string | null;
      text: string;
    };

export type ChatInlineTextSegment = {
  kind: "text" | "strong" | "code";
  text: string;
};

function isStructuredBlockStart(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^(`{3,}|~{3,})/.test(trimmed) ||
    /^#{1,3}\s+/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^[-*]\s+/.test(trimmed) ||
    /^\d+[.)]\s+/.test(trimmed)
  );
}

export function parseChatStructuredText(
  text: string,
): ChatStructuredTextBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ChatStructuredTextBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)/);
    if (fence) {
      const fenceMarker = fence[1];
      const codeLines: string[] = [];
      index += 1;
      while (
        index < lines.length &&
        !lines[index].trim().startsWith(fenceMarker)
      ) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        kind: "code",
        language: fence[2] ? fence[2] : null,
        text: codeLines.join("\n"),
      });
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: Math.min(heading[1].length, 3) as 1 | 2 | 3,
        text: heading[2],
      });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quoteLines.join("\n") });
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "unordered-list", items });
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+[.)]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "ordered-list", items });
      continue;
    }

    const paragraphLines: string[] = [lines[index]];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isStructuredBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
  }

  return blocks;
}

function appendStrongSegments(
  segments: ChatInlineTextSegment[],
  text: string,
): void {
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("**", cursor);
    if (start === -1) {
      if (cursor < text.length) {
        segments.push({ kind: "text", text: text.slice(cursor) });
      }
      return;
    }
    const end = text.indexOf("**", start + 2);
    if (end === -1) {
      segments.push({ kind: "text", text: text.slice(cursor) });
      return;
    }
    if (start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, start) });
    }
    const strongText = text.slice(start + 2, end);
    if (strongText) segments.push({ kind: "strong", text: strongText });
    cursor = end + 2;
  }
}

export function parseChatInlineText(text: string): ChatInlineTextSegment[] {
  const segments: ChatInlineTextSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf("`", cursor);
    if (start === -1) {
      appendStrongSegments(segments, text.slice(cursor));
      break;
    }
    const end = text.indexOf("`", start + 1);
    if (end === -1) {
      appendStrongSegments(segments, text.slice(cursor));
      break;
    }
    if (start > cursor) {
      appendStrongSegments(segments, text.slice(cursor, start));
    }
    const codeText = text.slice(start + 1, end);
    if (codeText) segments.push({ kind: "code", text: codeText });
    cursor = end + 1;
  }

  return segments.length > 0 ? segments : [{ kind: "text", text }];
}
