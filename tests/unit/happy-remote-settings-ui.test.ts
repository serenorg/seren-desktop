// ABOUTME: Static UI contract for Happy app discovery in Remote Access settings.
// ABOUTME: Keeps the explanation, official destinations, ratings, and safe link path visible.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const remoteSettings = readFileSync(
  resolve("src/components/settings/HappyRemoteSettings.tsx"),
  "utf-8",
);

describe("Happy Remote Access app discovery (#3127)", () => {
  it("explains Happy and exposes the verified install and learn-more actions", () => {
    expect(remoteSettings).toContain(
      "Happy is the free, open-source mobile remote control",
    );
    expect(remoteSettings).toContain("https://happy.engineering/");
    expect(remoteSettings).toContain(
      "https://apps.apple.com/us/app/happy-claude-code-client/id6748571505",
    );
    expect(remoteSettings).toContain(
      "https://play.google.com/store/apps/details?id=com.ex3ndr.happy",
    );
    expect(remoteSettings).toContain('score: "4.9"');
    expect(remoteSettings).toContain('count: "970+ ratings"');
    expect(remoteSettings).toContain('score: "4.8"');
    expect(remoteSettings).toContain('count: "2.9k+ reviews"');
    expect(remoteSettings).toContain('import { openExternalLink }');
    expect(remoteSettings).toContain("void openExternalLink(HAPPY_WEBSITE_URL)");
    expect(remoteSettings).toContain("void openExternalLink(store.url)");
  });
});

/**
 * Asserted against the source rather than a mounted component: the Vitest
 * project runs in a `node` environment with no DOM and no Solid test renderer,
 * so this section cannot be rendered here. These lock the two statements whose
 * absence caused the defects.
 */
describe("Happy Remote Access unmount teardown (#3151, #3153)", () => {
  const cleanup = remoteSettings.slice(
    remoteSettings.indexOf("onCleanup(() => {"),
    remoteSettings.indexOf("const toggleRemoteAccess"),
  );

  it("withdraws an in-flight pairing code when the section unmounts", () => {
    // Switching settings sections unmounts without going through the dismiss
    // button, and the bridge kept polling for the full 5 minute timeout with a
    // scanned QR still authorizable.
    expect(cleanup).toContain("pairingPayload()");
    expect(cleanup).toContain("cancelPairing()");
  });

  it("releases a status listener that resolved after the unmount", () => {
    // `onStatusChange` resolves after a round trip, so a fast unmount dropped
    // the handle and leaked a listener that kept reporting bridge errors.
    expect(cleanup).toContain("unmounted = true");
    expect(remoteSettings).toMatch(/if \(unmounted\) \{\s*unlisten\(\);/);
  });
});

describe("Happy advertised-root consent (#3144)", () => {
  it("derives roots from the same conversations the user sees checkboxes for", () => {
    // The UI lists agent conversations. If the bridge discovers roots from a
    // wider set, it advertises folders the user was never shown and cannot
    // withdraw — a remote spawn into them still passes is_advertised_root.
    expect(remoteSettings).toContain('listConversations({ kind: "agent" })');

    const bridge = readFileSync(resolve("src-tauri/src/happy_bridge.rs"), "utf-8");
    const call = bridge.match(
      /list_conversations\(\s*app\.clone\(\),\s*([^,]+),/,
    );
    expect(call).not.toBeNull();
    expect(call?.[1].trim()).toBe('Some("agent".to_string())');
  });
});

describe("Happy identity reset confirmation (#3223)", () => {
  it("awaits the supported Tauri dialog before invoking the reset", () => {
    const unpair = remoteSettings.slice(
      remoteSettings.indexOf("const unpair = async () => {"),
      remoteSettings.indexOf("\n  return ("),
    );

    expect(remoteSettings).toContain(
      'import { confirm } from "@tauri-apps/plugin-dialog";',
    );
    expect(unpair).toContain("const confirmed = await confirm(RESET_COPY");
    expect(unpair).toContain("if (!confirmed) return;");
    expect(unpair).not.toContain("window.confirm");
    expect(unpair.indexOf("await confirm")).toBeLessThan(
      unpair.indexOf("resetRemoteIdentity()"),
    );
  });
});
