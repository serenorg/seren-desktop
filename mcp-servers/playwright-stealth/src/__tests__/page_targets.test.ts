// ABOUTME: Tests for page target listing and selection tool wrappers.
// ABOUTME: Guards CDP attach workflows that bind to a user's authenticated tab.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPages, selectPage } from "../tools.js";

const mocks = vi.hoisted(() => ({
  listPages: vi.fn(),
  selectPage: vi.fn(),
}));

vi.mock("../browser.js", () => ({
  closeBrowser: vi.fn(),
  getActiveBrowserType: vi.fn(() => "chromium-cdp"),
  getContext: vi.fn(),
  getPage: vi.fn(),
  listPages: mocks.listPages,
  listInstalledBrowsers: vi.fn(() => []),
  resetPage: vi.fn(),
  selectPage: mocks.selectPage,
  setBrowser: vi.fn(),
}));

describe("page target tools", () => {
  beforeEach(() => {
    mocks.listPages.mockReset();
    mocks.selectPage.mockReset();
  });

  it("serializes open page targets", async () => {
    mocks.listPages.mockResolvedValue([
      {
        id: "page-1",
        index: 0,
        url: "https://bank.example/accounts",
        title: "Accounts",
        isActive: true,
      },
    ]);

    await expect(listPages()).resolves.toBe(
      JSON.stringify(
        [
          {
            id: "page-1",
            index: 0,
            url: "https://bank.example/accounts",
            title: "Accounts",
            isActive: true,
          },
        ],
        null,
        2,
      ),
    );
  });

  it("selects a page target and reports its URL", async () => {
    mocks.selectPage.mockResolvedValue({
      url: () => "https://bank.example/statements",
    });

    await expect(selectPage({ id: "page-2" })).resolves.toBe(
      "Selected page: https://bank.example/statements",
    );
    expect(mocks.selectPage).toHaveBeenCalledWith({ id: "page-2" });
  });
});
