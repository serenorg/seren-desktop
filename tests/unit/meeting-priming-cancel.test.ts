// ABOUTME: Regression test for #2160 — cancelling first-run priming and startup reconcile must not strand a capturing zombie.
// ABOUTME: A leftover `capturing` row blocks isCapturing() and every future start.

import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  updateMeetingStatus: vi.fn(async () => {}),
  listMeetings: vi.fn(async (): Promise<Meeting[]> => []),
}));

vi.mock("@/lib/tauri-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-bridge")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/services/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/meetings")>()),
  updateMeetingStatus: services.updateMeetingStatus,
  listMeetings: services.listMeetings,
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
    services.listMeetings.mockResolvedValue([]);
  });

  it("cancelPriming marks the stashed capturing meeting failed", async () => {
    // Not yet primed -> requestCaptureStart stashes the (already-capturing) row.
    await meetingStore.requestCaptureStart(meeting({ id: "z1" }));
    expect(meetingStore.state.primingRequest?.id).toBe("z1");

    await meetingStore.cancelPriming();

    expect(meetingStore.state.primingRequest).toBeNull();
    expect(services.updateMeetingStatus).toHaveBeenCalledWith(
      "z1",
      "failed",
      expect.any(Number),
    );
    expect(services.listMeetings).toHaveBeenCalled();
  });

  it("reconcileStaleCaptures fails leftover mid-pipeline rows, leaves terminal ones", async () => {
    services.listMeetings.mockResolvedValueOnce([
      meeting({ id: "cap", status: "capturing" }),
      meeting({ id: "trans", status: "transcribing" }),
      meeting({ id: "agent", status: "agent_running" }),
      meeting({ id: "done1", status: "done" }),
      meeting({ id: "notes", status: "notes_ready" }),
    ]);

    await meetingStore.reconcileStaleCaptures();

    // Fail every mid-pipeline zombie, with no ended_at so a captured row keeps
    // its capture-end time (#2174).
    for (const id of ["cap", "trans", "agent"]) {
      expect(services.updateMeetingStatus).toHaveBeenCalledWith(id, "failed");
    }
    // Terminal/resting rows are left alone.
    for (const id of ["done1", "notes"]) {
      expect(services.updateMeetingStatus).not.toHaveBeenCalledWith(
        id,
        "failed",
      );
    }
  });
});
