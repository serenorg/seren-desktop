// ABOUTME: Regression test for #2160 — cancelling first-run priming and startup reconcile must not strand a capturing zombie.
// ABOUTME: A leftover `capturing` row blocks isCapturing() and every future start.

import { beforeEach, describe, expect, it, vi } from "vitest";

const services = vi.hoisted(() => ({
  updateMeetingStatus: vi.fn(async () => {}),
  listMeetings: vi.fn(async () => []),
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

  it("reconcileStaleCaptures fails leftover capturing rows, leaves others", async () => {
    services.listMeetings.mockResolvedValueOnce([
      meeting({ id: "stale", status: "capturing" }),
      meeting({ id: "done1", status: "done" }),
    ]);

    await meetingStore.reconcileStaleCaptures();

    expect(services.updateMeetingStatus).toHaveBeenCalledWith(
      "stale",
      "failed",
      expect.any(Number),
    );
    expect(services.updateMeetingStatus).not.toHaveBeenCalledWith(
      "done1",
      "failed",
      expect.any(Number),
    );
  });
});
