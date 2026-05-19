// ABOUTME: Critical regression test for agent composer toolbar layout invariants.
// ABOUTME: Guards against Cancel-button clipping when chip row grows (#1982).

import { describe, expect, it } from "vitest";
import {
  COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES,
  COMPOSER_TOOLBAR_RIGHT_GROUP_CLASSES,
  COMPOSER_TOOLBAR_ROOT_CLASSES,
} from "@/components/chat/composerToolbarClasses";

describe("composer toolbar layout invariants (#1982)", () => {
  it("right group must be pinned with shrink-0 so Cancel/Send is never clipped", () => {
    expect(COMPOSER_TOOLBAR_RIGHT_GROUP_CLASSES).toMatch(/\bshrink-0\b/);
  });

  it("left group must shrink (min-w-0 + flex-1) before pushing the right group off-screen", () => {
    expect(COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES).toMatch(/\bmin-w-0\b/);
    expect(COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES).toMatch(/\bflex-1\b/);
  });

  it("left group must allow horizontal scroll so clipped chips remain reachable", () => {
    expect(COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES).toMatch(/\boverflow-x-auto\b/);
  });

  it("root toolbar must keep gap between the two groups", () => {
    expect(COMPOSER_TOOLBAR_ROOT_CLASSES).toMatch(/\bjustify-between\b/);
    expect(COMPOSER_TOOLBAR_ROOT_CLASSES).toMatch(/\bgap-\d+\b/);
  });
});
