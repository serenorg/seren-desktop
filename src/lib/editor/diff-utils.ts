// ABOUTME: Utilities for computing and displaying code diffs.
// ABOUTME: Used by inline edit feature to show before/after comparison.

export interface DiffLine {
  type: "unchanged" | "added" | "removed";
  content: string;
}

/**
 * Compute a simple line-by-line diff between original and modified text.
 * Uses a basic comparison - sufficient for inline edit previews.
 */
export function computeSimpleDiff(
  original: string,
  modified: string,
): DiffLine[] {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  const result: DiffLine[] = [];

  let i = 0;
  let j = 0;

  while (i < originalLines.length || j < modifiedLines.length) {
    if (i >= originalLines.length) {
      // Only modified lines left - all additions
      result.push({ type: "added", content: modifiedLines[j] });
      j++;
    } else if (j >= modifiedLines.length) {
      // Only original lines left - all removals
      result.push({ type: "removed", content: originalLines[i] });
      i++;
    } else if (originalLines[i] === modifiedLines[j]) {
      // Lines match - unchanged
      result.push({ type: "unchanged", content: originalLines[i] });
      i++;
      j++;
    } else {
      // Lines differ - show removal then addition
      result.push({ type: "removed", content: originalLines[i] });
      result.push({ type: "added", content: modifiedLines[j] });
      i++;
      j++;
    }
  }

  return result;
}

/**
 * Extract code from an AI response that may contain markdown fences.
 * Returns the code content stripped of fence markers.
 */
export function extractCodeFromResponse(response: string): string {
  // Try to extract code from markdown fence
  const fenceMatch = response.match(/```(?:\w+)?\n?([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // If no fence, return as-is (trimmed)
  return response.trim();
}
