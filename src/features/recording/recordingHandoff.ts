// ABOUTME: Reactive handoff for a screen recording stopped from the titlebar.
// ABOUTME: The titlebar offers the session; the active chat composer consumes it.

import type { RecordingSession } from "@seren/recording-core";
import { createSignal } from "solid-js";

export interface RecordingHandoffEntry {
  session: RecordingSession;
  releaseArtifacts?: () => void;
}

const [pendingEntry, setPendingEntry] =
  createSignal<RecordingHandoffEntry | null>(null);

export const recordingHandoff = {
  /** The stopped session and release callback awaiting a composer, or null. */
  get pendingEntry(): RecordingHandoffEntry | null {
    return pendingEntry();
  },
  /** The stopped session awaiting a composer, or null. Tracked when read. */
  get pending(): RecordingSession | null {
    return pendingEntry()?.session ?? null;
  },
  /** Offer a stopped session for the active composer to pick up. */
  offer(session: RecordingSession | null, releaseArtifacts?: () => void): void {
    if (!session) return;
    pendingEntry()?.releaseArtifacts?.();
    setPendingEntry({ session, releaseArtifacts });
  },
  /** Drop the pending session once a composer has taken it. */
  clear(): void {
    setPendingEntry(null);
  },
};
