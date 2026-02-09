// ABOUTME: Context retrieval for AI chat using semantic code search.
// ABOUTME: Automatically finds relevant code chunks and injects them into AI prompts.

import type { SearchResult } from "@/services/indexing";
import { searchCodebase } from "@/services/indexing";
import { settingsStore } from "@/stores/settings.store";

/** Maximum number of code chunks to inject as context */
const MAX_CONTEXT_CHUNKS = 5;

/** Minimum similarity threshold (0-1, lower is more similar in distance metrics) */
const MIN_SIMILARITY_THRESHOLD = 0.8;

/**
 * Retrieve relevant code context for a user query.
 * Returns formatted markdown string to inject into system prompt.
 */
export async function retrieveCodeContext(
  projectPath: string | null,
  userQuery: string,
): Promise<string | null> {
  // Check if indexing is enabled
  const indexingEnabled = settingsStore.get("semanticIndexingEnabled");
  if (!indexingEnabled) {
    return null;
  }

  // Check if we have a project path
  if (!projectPath) {
    return null;
  }

  try {
    // Search for relevant code chunks
    const results = await searchCodebase(
      projectPath,
      userQuery,
      MAX_CONTEXT_CHUNKS,
    );

    // Filter by similarity threshold
    const relevantResults = results.filter(
      (r) => r.distance < MIN_SIMILARITY_THRESHOLD,
    );

    if (relevantResults.length === 0) {
      return null;
    }

    // Format results as markdown
    return formatCodeContext(relevantResults);
  } catch (error) {
    console.warn("[Context Retrieval] Failed to retrieve code context:", error);
    return null;
  }
}

/**
 * Format search results as markdown for injection into system prompt.
 */
function formatCodeContext(results: SearchResult[]): string {
  let markdown = "\n\n## Relevant Codebase Context\n\n";
  markdown +=
    "The following code from the project may be relevant to the user's request:\n\n";

  for (const result of results) {
    const { chunk, distance } = result;
    markdown += `### ${chunk.file_path}:${chunk.start_line}-${chunk.end_line}`;

    if (chunk.symbol_name) {
      markdown += ` (${chunk.chunk_type}: ${chunk.symbol_name})`;
    }

    // Add similarity indicator (optional, can be removed)
    const similarityPercent = Math.round((1 - distance) * 100);
    markdown += ` [${similarityPercent}% relevant]\n\n`;

    markdown += "```" + chunk.language + "\n";
    markdown += chunk.content + "\n";
    markdown += "```\n\n";
  }

  return markdown;
}

/**
 * Check if semantic indexing is available for a project.
 */
export async function isIndexingAvailable(
  projectPath: string | null,
): Promise<boolean> {
  if (!projectPath) {
    return false;
  }

  const indexingEnabled = settingsStore.get("semanticIndexingEnabled");
  if (!indexingEnabled) {
    return false;
  }

  try {
    const { hasProjectIndex } = await import("@/services/indexing");
    return await hasProjectIndex(projectPath);
  } catch {
    return false;
  }
}
