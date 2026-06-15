// ABOUTME: Regression test for #2160 — cancelling first-run priming and startup reconcile must not strand a capturing zombie.
// ABOUTME: A leftover `capturing` row blocks isCapturing() and every future start.

import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  updateMeetingStatus: vi.fn(async () => {}),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
  isMeetingCaptureActive: vi.fn(async () => false),
  getMeetingTranscriptText: vi.fn(async (_id: string) => ""),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  updateMeetingStatus: services.updateMeetingStatus,
  listMeetings: services.listMeetings,
  isMeetingCaptureActive: services.isMeetingCaptureActive,
  getMeetingTranscriptText: services.getMeetingTranscriptText,
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: { get: () => false, set: vi.fn() },
}));

import type { Meeting } from "@/services/meetings";
import { meetingStore } from "@/stores/meeting.store";

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "m1",
    title: "T",
    sourceApp: "Manual",
    startedAt: 0,
    endedAt: null,
    status: "capturing",
    templateId: null,
    routedSkillSlug: null,
    agentConversationId: null,
    notesMarkdown: null,
    notesStructJson: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("meetingStore priming cancel + reconcile (#2160)", () => {
  beforeEach(() => {
    services.updateMeetingStatus.mockClear();
    services.listMeetings.mockReset();
    services.isMeetingCaptureActive.mockReset();
    services.getMeetingTranscriptText.mockReset();
    services.listMeetings.mockResolvedValue([]);
    services.isMeetingCaptureActive.mockResolvedValue(false);
    services.getMeetingTranscriptText.mockResolvedValue("");
  });

  it("cancelPriming marks the stashed pending meeting failed", async () => {
    // Not yet primed -> requestCaptureStart stashes the pending backend row.
    await meetingStore.requestCaptureStart(
      meeting({ id: "z1", status: "pending_capture" }),
    );
    expect(meetingStore.state.primingRequest?.id).toBe("z1");

    await meetingStore.cancelPriming();

    expect(meetingStore.state.primingRequest).toBeNull();
    expect(services.updateMeetingStatus).toHaveBeenCalledWith(
      "z1",
      "failed",
      expect.any(Number),
      expect.stringContaining("canceled"),
    );
    expect(services.listMeetings).toHaveBeenCalled();
  });

  it("reconcileStaleCaptures preserves usable transcripts and fails true zombies", async () => {
    services.listMeetings.mockResolvedValueOnce([
      meeting({ id: "pending", status: "pending_capture" }),
      meeting({ id: "cap", status: "capturing" }),
      meeting({ id: "trans", status: "transcribing" }),
      meeting({ id: "agent", status: "agent_running" }),
      meeting({ id: "done1", status: "done" }),
      meeting({ id: "notes", status: "notes_ready" }),
    ]);
    services.getMeetingTranscriptText.mockImplementation(async (id: string) =>
      id === "trans" ? "saved transcript" : "",
    );

    await meetingStore.reconcileStaleCaptures();

    // Fail true mid-pipeline zombies, with no ended_at so a captured row keeps
    // its capture-end time (#2174). A stopped meeting with transcript text is
    // reviewable even if notes generation was interrupted (#2440).
    expect(services.isMeetingCaptureActive).toHaveBeenCalledWith("cap");
    expect(services.updateMeetingStatus).toHaveBeenCalledWith(
      "cap",
      "failed",
      null,
      expect.stringContaining("without an active backend capture"),
    );
    for (const id of ["pending", "agent"]) {
      expect(services.updateMeetingStatus).toHaveBeenCalledWith(
        id,
        "failed",
        null,
        expect.stringContaining("Seren restarted"),
      );
    }
    expect(services.updateMeetingStatus).toHaveBeenCalledWith(
      "trans",
      "transcript_ready",
      null,
      expect.stringContaining("transcript is ready"),
    );
    // Terminal/resting rows are left alone.
    for (const id of ["done1", "notes"]) {
      expect(services.updateMeetingStatus).not.toHaveBeenCalledWith(
        id,
        "failed",
      );
    }
  });
});
