// ABOUTME: Unit tests for the native notification service permission gating.
// ABOUTME: Protects the fix that routes OS banners through the Tauri plugin only when granted.

import { beforeEach, describe, expect, it, vi } from "vitest";

const isPermissionGrantedMock = vi.fn<() => Promise<boolean>>();
const requestPermissionMock = vi.fn<() => Promise<string>>();
const sendNotificationMock = vi.fn<(options: unknown) => void>();

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: isPermissionGrantedMock,
  requestPermission: requestPermissionMock,
  sendNotification: sendNotificationMock,
}));

describe("notifications service permission gating", () => {
  beforeEach(() => {
    vi.resetModules();
    isPermissionGrantedMock.mockReset();
    requestPermissionMock.mockReset();
    sendNotificationMock.mockReset();
  });

  it("sends once and skips the prompt when permission is already granted", async () => {
    isPermissionGrantedMock.mockResolvedValue(true);
    const { postNotification } = await import("@/services/notifications");

    await postNotification("Approval needed", "Waiting for approval.");

    expect(requestPermissionMock).not.toHaveBeenCalled();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledWith({
      title: "Approval needed",
      body: "Waiting for approval.",
    });
  });

  it("never posts a banner when permission is denied", async () => {
    isPermissionGrantedMock.mockResolvedValue(false);
    requestPermissionMock.mockResolvedValue("denied");
    const { postNotification } = await import("@/services/notifications");

    await postNotification("Approval needed", "Waiting for approval.");

    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("requests permission when undecided and posts once after a grant", async () => {
    isPermissionGrantedMock.mockResolvedValue(false);
    requestPermissionMock.mockResolvedValue("granted");
    const { postNotification } = await import("@/services/notifications");

    await postNotification("Approval needed", "Waiting for approval.");

    expect(requestPermissionMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("swallows plugin errors so callers never fail", async () => {
    isPermissionGrantedMock.mockRejectedValue(new Error("plugin unavailable"));
    const { postNotification } = await import("@/services/notifications");

    await expect(
      postNotification("Approval needed", "Waiting for approval."),
    ).resolves.toBeUndefined();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
