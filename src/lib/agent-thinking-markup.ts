// ABOUTME: Normalizes Claude-style <think> blocks out of visible assistant text.
// ABOUTME: Keeps raw model reasoning in the existing ThinkingBlock rendering path. #1911.

export interface AgentThinkingMarkupParts {
  content: string;
  thinking: string;
}

export interface AgentThinkingMarkupStreamState {
  insideThink: boolean;
  pending: string;
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function normalizeFinalText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findMarker(source: string, marker: string): number {
  return source.toLowerCase().indexOf(marker);
}

function longestMarkerPrefixSuffix(source: string, marker: string): string {
  const lowerSource = source.toLowerCase();
  const maxLength = Math.min(marker.length - 1, source.length);

  for (let length = maxLength; length > 0; length -= 1) {
    if (marker.startsWith(lowerSource.slice(-length))) {
      return source.slice(-length);
    }
  }

  return "";
}

export function createAgentThinkingMarkupStreamState(): AgentThinkingMarkupStreamState {
  return { insideThink: false, pending: "" };
}

export function extractAgentThinkingMarkup(
  text: string,
): AgentThinkingMarkupParts {
  if (!text?.toLowerCase().includes(THINK_OPEN)) {
    return { content: text, thinking: "" };
  }

  const contentParts: string[] = [];
  const thinkingParts: string[] = [];
  let source = text;

  while (source.length > 0) {
    const openIndex = findMarker(source, THINK_OPEN);
    if (openIndex === -1) {
      contentParts.push(source);
      break;
    }

    contentParts.push(source.slice(0, openIndex));
    const afterOpen = source.slice(openIndex + THINK_OPEN.length);
    const closeIndex = findMarker(afterOpen, THINK_CLOSE);

    if (closeIndex === -1) {
      thinkingParts.push(afterOpen);
      break;
    }

    thinkingParts.push(afterOpen.slice(0, closeIndex));
    source = afterOpen.slice(closeIndex + THINK_CLOSE.length);
  }

  return {
    content: normalizeFinalText(contentParts.join("")),
    thinking: normalizeFinalText(thinkingParts.join("\n\n")),
  };
}

export function consumeAgentThinkingMarkupChunk(
  state: AgentThinkingMarkupStreamState,
  chunk: string,
): AgentThinkingMarkupParts {
  if (!chunk && !state.pending) {
    return { content: "", thinking: "" };
  }

  let source = state.pending + chunk;
  state.pending = "";
  let content = "";
  let thinking = "";

  while (source.length > 0) {
    const marker = state.insideThink ? THINK_CLOSE : THINK_OPEN;
    const markerIndex = findMarker(source, marker);

    if (markerIndex !== -1) {
      const beforeMarker = source.slice(0, markerIndex);
      if (state.insideThink) {
        thinking += beforeMarker;
      } else {
        content += beforeMarker;
      }
      state.insideThink = !state.insideThink;
      source = source.slice(markerIndex + marker.length);
      continue;
    }

    const pending = longestMarkerPrefixSuffix(source, marker);
    const emit = source.slice(0, source.length - pending.length);
    if (state.insideThink) {
      thinking += emit;
    } else {
      content += emit;
    }
    state.pending = pending;
    break;
  }

  return { content, thinking };
}

export function flushAgentThinkingMarkupRemainder(
  state: AgentThinkingMarkupStreamState,
): AgentThinkingMarkupParts {
  const pending = state.pending;
  state.pending = "";

  if (!pending) {
    return { content: "", thinking: "" };
  }

  return state.insideThink
    ? { content: "", thinking: pending }
    : { content: pending, thinking: "" };
}
