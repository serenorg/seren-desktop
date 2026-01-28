// ABOUTME: Indexing orchestration workflow coordinator.
// ABOUTME: Manages the end-to-end indexing process: discover → chunk → embed → store.

import { invoke } from "@tauri-apps/api/core";
import { indexingStore } from "@/stores/indexing.store";
import { embedTexts } from "@/services/seren-embed";
import { indexChunks } from "@/services/indexing";
import type { DiscoveredFile, ChunkedFile, FileChunk } from "@/services/indexing";

const BATCH_SIZE = 20; // Process 20 chunks at a time

interface IndexingResult {
  totalFiles: number;
  totalChunks: number;
  totalTokens: number;
  duration: number;
}

/**
 * Run the full indexing workflow for a project.
 */
export async function runIndexing(projectPath: string): Promise<IndexingResult> {
  const startTime = Date.now();
  let totalChunks = 0;
  let totalTokens = 0;

  try {
    // Phase 1: Initialize index database
    indexingStore.setPhase("discovering");
    await invoke("init_project_index", { projectPath });

    // Phase 2: Discover files
    indexingStore.setPhase("discovering");
    const files = await invoke<DiscoveredFile[]>("discover_project_files", { projectPath });

    if (files.length === 0) {
      throw new Error("No indexable files found in project");
    }

    indexingStore.updateProgress({
      filesTotal: files.length,
      filesProcessed: 0,
    });

    // Phase 3: Estimate work
    const [estimatedChunks, estimatedTokens] = await invoke<[number, number]>("estimate_indexing", {
      files,
    });

    indexingStore.updateProgress({
      chunksTotal: estimatedChunks,
      estimatedTokens: estimatedTokens,
    });

    // Phase 4: Process files in batches
    indexingStore.setPhase("chunking");

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      indexingStore.updateProgress({
        filesProcessed: i,
        currentFile: file.relative_path,
      });

      // Check if file needs indexing
      const needsIndex = await invoke<boolean>("file_needs_reindex", {
        projectPath,
        filePath: file.relative_path,
        fileHash: file.hash,
      });

      if (!needsIndex) {
        continue; // Skip files that haven't changed
      }

      // Delete old chunks if re-indexing
      await invoke("delete_file_index", {
        projectPath,
        filePath: file.relative_path,
      });

      // Chunk the file
      const chunked = await invoke<ChunkedFile>("chunk_file", { file });

      if (chunked.chunks.length === 0) {
        continue; // Skip files with no chunks
      }

      // Phase 5: Generate embeddings in batches
      indexingStore.setPhase("embedding");

      for (let j = 0; j < chunked.chunks.length; j += BATCH_SIZE) {
        const batch = chunked.chunks.slice(j, j + BATCH_SIZE);
        const texts = batch.map((c: { content: string }) => c.content);

        // Generate embeddings via SerenEmbed
        const embeddingResponse = await embedTexts(texts);
        totalTokens += embeddingResponse.usage.total_tokens;

        // Phase 6: Store chunks with embeddings
        indexingStore.setPhase("storing");

        const chunksToStore = batch.map((chunk: FileChunk, idx: number) => ({
          file_path: file.relative_path,
          start_line: chunk.start_line,
          end_line: chunk.end_line,
          content: chunk.content,
          chunk_type: chunk.chunk_type,
          symbol_name: chunk.symbol_name,
          language: file.language,
          file_hash: file.hash,
          embedding: embeddingResponse.data[idx].embedding,
        }));

        await indexChunks(projectPath, chunksToStore);

        totalChunks += batch.length;
        indexingStore.updateProgress({
          chunksProcessed: totalChunks,
        });
      }
    }

    // Phase 7: Complete
    indexingStore.setPhase("complete");
    indexingStore.updateProgress({
      filesProcessed: files.length,
    });

    // Refresh stats
    await indexingStore.refreshStats();

    const duration = Date.now() - startTime;

    return {
      totalFiles: files.length,
      totalChunks,
      totalTokens,
      duration,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexing failed";
    indexingStore.setError(message);
    throw error;
  }
}

/**
 * Re-index a single file (called on file save).
 */
export async function reindexFile(
  projectPath: string,
  filePath: string,
): Promise<void> {
  try {
    // Read file content
    const content = await invoke<string>("read_file", { path: filePath });

    // Compute hash
    const hash = await invoke<string>("compute_file_hash", { content });

    // Check if needs reindex
    const needsIndex = await invoke<boolean>("file_needs_reindex", {
      projectPath,
      filePath,
      fileHash: hash,
    });

    if (!needsIndex) {
      return; // File hasn't changed
    }

    // Get file info
    const files = await invoke<DiscoveredFile[]>("discover_project_files", { projectPath });
    const file = files.find((f) => f.path === filePath);

    if (!file) {
      return; // File not indexable
    }

    // Delete old chunks
    await invoke("delete_file_index", { projectPath, filePath: file.relative_path });

    // Chunk the file
    const chunked = await invoke<ChunkedFile>("chunk_file", { file });

    if (chunked.chunks.length === 0) {
      return;
    }

    // Generate embeddings
    const texts = chunked.chunks.map((c: FileChunk) => c.content);
    const embeddingResponse = await embedTexts(texts);

    // Store chunks
    const chunksToStore = chunked.chunks.map((chunk: FileChunk, idx: number) => ({
      file_path: file.relative_path,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
      content: chunk.content,
      chunk_type: chunk.chunk_type,
      symbol_name: chunk.symbol_name,
      language: file.language,
      file_hash: file.hash,
      embedding: embeddingResponse.data[idx].embedding,
    }));

    await indexChunks(projectPath, chunksToStore);

    // Refresh stats
    await indexingStore.refreshStats();
  } catch (error) {
    console.error("[Orchestrator] Failed to reindex file:", error);
  }
}
