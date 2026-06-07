// ABOUTME: Local dictation cleanup helpers shared by voice input surfaces.
// ABOUTME: Removes common fillers and applies user vocabulary casing.

const FILLER_PATTERN =
  /\b(?:um+|uh+|erm+|ah+|like|you know|i mean|sort of|kind of)\b/gi;

export function cleanupDictationText(
  raw: string,
  vocabulary: string[] = [],
): string {
  const collapsed = raw
    .replace(FILLER_PATTERN, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([,.!?;:]){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (!collapsed) return "";

  const withVocabulary = vocabulary
    .map((term) => term.trim())
    .filter(Boolean)
    .reduce((text, term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return text.replace(new RegExp(`\\b${escaped}\\b`, "gi"), term);
    }, collapsed);

  return withVocabulary.charAt(0).toUpperCase() + withVocabulary.slice(1);
}
