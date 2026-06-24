// ABOUTME: Contract tests for the titlebar→composer recording handoff store.
// ABOUTME: Guards #2614 — a stopped session must survive until a composer takes it.

import type { RecordingSession } from "@seren/recording-core";
import { beforeEach, describe, expect, it } from "vitest";
import { recordingHandoff } from "@/features/recording/recordingHandoff";

function session(id: string): RecordingSession {
  return {
    id,
    targetKind: "screen",
    targetLabel: "Workflow recording",
    startedAtMs: 0,
    outputDir: "/tmp/rec",
    maxVideoHeight: 720,
  };
}

describe("recordingHandoff (#2614)", () => {
  beforeEach(() => recordingHandoff.clear());

  it("holds an offered session until it is cleared", () => {
    expect(recordingHandoff.pending).toBeNull();
    const stopped = session("a");
    recordingHandoff.offer(stopped);
    expect(recordingHandoff.pending).toBe(stopped);
    recordingHandoff.clear();
    expect(recordingHandoff.pending).toBeNull();
  });

  it("ignores a null offer so a no-op stop never sets a phantom session", () => {
    recordingHandoff.offer(null);
    expect(recordingHandoff.pending).toBeNull();
  });

  it("retains the latest offered session, replacing an unconsumed one", () => {
    const first = session("first");
    const second = session("second");
    recordingHandoff.offer(first);
    recordingHandoff.offer(second);
    expect(recordingHandoff.pending).toBe(second);
  });
});
