// ABOUTME: Codebase indexing service for semantic code search.
// ABOUTME: Orchestrates file discovery, chunking, embedding, and vector storage.

import { invoke } from "@tauri-apps/api/core";
import {
  EMBEDDING_DIM,
  embedText,
  embedTexts,
  estimateBatchTokens,
} from "./seren-embed";

/** Index statistics from the backend */
export interface IndexStats {
  total_chunks: number;
  total_files: number;
  last_indexed: number | null;
}

/** A code chunk with metadata */
export interface CodeChunk {
  id: number;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  chunk_type: string;
  symbol_name: string | null;
  language: string;
  file_hash: string;
  indexed_at: number;
}

/** Search result with similarity distance */
export interface SearchResult {
  chunk: CodeChunk;
  distance: number;
}

/** Discovered file from backend */
export interface DiscoveredFile {
  path: string;
  relative_path: string;
  language: string;
  size: number;
  hash: string;
}

/** File chunk from backend */
export interface FileChunk {
  start_line: number;
  end_line: number;
  content: string;
  chunk_type: string;
  symbol_name: string | null;
}

/** Chunked file from backend */
export interface ChunkedFile {
  file: DiscoveredFile;
  chunks: FileChunk[];
}

/** Chunk input for indexing */
interface ChunkInput {
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  chunk_type: string;
  symbol_name: string | null;
  language: string;
  file_hash: string;
  embedding: number[];
}

/** Indexing progress callback */
export type ProgressCallback = (progress: IndexingProgress) => void;

export interface IndexingProgress {
  phase: "discovering" | "chunking" | "embedding" | "storing" | "complete";
  filesTotal: number;
  filesProcessed: number;
  chunksTotal: number;
  chunksProcessed: number;
  currentFile: string | null;
  estimatedTokens: number;
}

/**
 * Initialize or get the index for a project.
 */
export async function initProjectIndex(
  projectPath: string,
): Promise<IndexStats> {
  return invoke<IndexStats>("init_project_index", { projectPath });
}

/**
 * Get index statistics for a project.
 */
export async function getIndexStatus(projectPath: string): Promise<IndexStats> {
  return invoke<IndexStats>("get_index_status", { projectPath });
}

/**
 * Check if an index exists for a project.
 */
export async function hasProjectIndex(projectPath: string): Promise<boolean> {
  return invoke<boolean>("has_project_index", { projectPath });
}

/**
 * Search the codebase for similar code using a text query.
 * First embeds the query, then searches the vector store.
 */
export async function searchCodebase(
  projectPath: string,
  query: string,
  limit = 5,
): Promise<SearchResult[]> {
  // Generate embedding for the query
  const queryEmbedding = await embedText(query);

  // Search the vector store
  return invoke<SearchResult[]>("search_codebase", {
    projectPath,
    queryEmbedding,
    limit,
  });
}

/**
 * Search the codebase using a pre-computed embedding.
 */
export async function searchCodebaseByEmbedding(
  projectPath: string,
  queryEmbedding: number[],
  limit = 5,
): Promise<SearchResult[]> {
  return invoke<SearchResult[]>("search_codebase", {
    projectPath,
    queryEmbedding,
    limit,
  });
}

/**
 * Check if a file needs re-indexing.
 */
export async function fileNeedsReindex(
  projectPath: string,
  filePath: string,
  fileHash: string,
): Promise<boolean> {
  return invoke<boolean>("file_needs_reindex", {
    projectPath,
    filePath,
    fileHash,
  });
}

/**
 * Delete index for a file (before re-indexing).
 */
export async function deleteFileIndex(
  projectPath: string,
  filePath: string,
): Promise<number> {
  return invoke<number>("delete_file_index", { projectPath, filePath });
}

/**
 * Index a batch of code chunks.
 * Generates embeddings via SerenEmbed and stores in local vector db.
 */
export async function indexChunks(
  projectPath: string,
  chunks: Omit<ChunkInput, "embedding">[],
  onProgress?: (processed: number, total: number) => void,
): Promise<number[]> {
  if (chunks.length === 0) return [];

  // Batch size for embedding API calls
  const BATCH_SIZE = 20;
  const allIds: number[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.content);

    // Generate embeddings for the batch
    const embeddingResponse = await embedTexts(texts);

    // Combine chunks with their embeddings
    const chunksWithEmbeddings: ChunkInput[] = batch.map((chunk, j) => ({
      ...chunk,
      embedding: embeddingResponse.data[j].embedding,
    }));

    // Store in vector database
    const ids = await invoke<number[]>("index_chunks", {
      projectPath,
      chunks: chunksWithEmbeddings,
    });

    allIds.push(...ids);

    if (onProgress) {
      onProgress(Math.min(i + BATCH_SIZE, chunks.length), chunks.length);
    }
  }

  return allIds;
}

/**
 * Get the expected embedding dimension.
 */
export function getEmbeddingDimension(): number {
  return EMBEDDING_DIM;
}

/**
 * Estimate the token cost for indexing files.
 */
export function estimateIndexingCost(contents: string[]): number {
  return estimateBatchTokens(contents);
}

// Re-export types
export type { ChunkInput };
