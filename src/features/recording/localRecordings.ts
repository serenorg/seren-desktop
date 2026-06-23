// ABOUTME: Service for listing, revealing, and deleting native local recordings.
// ABOUTME: Wraps the Tauri recording commands so components never invoke directly.

import type { RecordingCaptureStats } from "@seren/recording-core";
import { isTauriRuntime } from "@/lib/tauri-bridge";

export interface LocalRecordingSummary {
  id: string;
  outputDir: string;
  videoUrl: string | null;
  sizeBytes: number | null;
  startedAtMs: number | null;
  targetKind: "screen" | "window" | "browser" | string | null;
  targetLabel: string | null;
  keyframeCount: number | null;
  captureStats: RecordingCaptureStats | null;
  hasMetadata: boolean;
}

export function formatCaptureStats(
  stats: RecordingCaptureStats | null | undefined,
): string | null {
  if (!stats) return null;
  const parts = [];
  if (typeof stats.framesEncoded === "number") {
    parts.push(`${stats.framesEncoded} encoded`);
  }
  if (typeof stats.effectiveFps === "number") {
    parts.push(`${stats.effectiveFps.toFixed(1)} fps`);
  }
  if (typeof stats.framesSkipped === "number" && stats.framesSkipped > 0) {
    parts.push(`${stats.framesSkipped} skipped`);
  }
  if (parts.length === 0) return stats.backend;
  return parts.join(" - ");
}

async function getInvoke(): Promise<
  typeof import("@tauri-apps/api/core").invoke | null
> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

export async function listLocalRecordings(): Promise<LocalRecordingSummary[]> {
  const invoke = await getInvoke();
  if (!invoke) return [];
  return await invoke<LocalRecordingSummary[]>("recording_list_local");
}

export async function deleteLocalRecording(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  await invoke("recording_delete_local", { id });
}

export async function revealLocalRecording(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  await invoke("recording_reveal_local", { id });
}
