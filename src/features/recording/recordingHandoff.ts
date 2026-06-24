// ABOUTME: Reactive handoff for a screen recording stopped from the titlebar.
// ABOUTME: The titlebar offers the session; the active chat composer consumes it.

import type { RecordingSession } from "@seren/recording-core";
import { createSignal } from "solid-js";

const [pendingSession, setPendingSession] =
  createSignal<RecordingSession | null>(null);

export const recordingHandoff = {
  /** The stopped session awaiting a composer, or null. Tracked when read. */
  get pending(): RecordingSession | null {
    return pendingSession();
  },
  /** Offer a stopped session for the active composer to pick up. */
  offer(session: RecordingSession | null): void {
    if (!session) return;
    setPendingSession(session);
  },
  /** Drop the pending session once a composer has taken it. */
  clear(): void {
    setPendingSession(null);
  },
};
