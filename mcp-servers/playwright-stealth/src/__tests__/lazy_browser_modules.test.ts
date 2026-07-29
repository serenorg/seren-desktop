// ABOUTME: Regression guard for #3452 — importing browser.js must not load the
// ABOUTME: heavy playwright-extra/stealth modules until first browser use (#3424).

import { createRequire } from "node:module";
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

/** True when a module under the given package directory is in Node's CJS cache. */
function isPackageLoaded(packageName: string): boolean {
  return Object.keys(require.cache ?? {}).some((modulePath) =>
    modulePath.split(sep).includes(packageName),
  );
}

describe("browser.ts lazy module contract (#3424)", () => {
  it("defers playwright-extra + stealth plugin until ensureBrowserModules()", async () => {
    // Both packages are CommonJS, so vitest hands them to Node's native
    // loader and every load lands in require.cache. Vitest runs each test
    // file in its own process, so this file observes a genuinely fresh
    // registry — browser.test.ts's beforeAll(ensureBrowserModules) cannot
    // pollute it. No test in THIS file may import browser.js at top level.
    expect(isPackageLoaded("playwright-extra")).toBe(false);
    expect(isPackageLoaded("puppeteer-extra-plugin-stealth")).toBe(false);

    // The regression #3424 fixed: a top-level `import` of playwright-extra
    // in browser.ts ran during the MCP `initialize` handshake window and
    // stalled agent startup on cold machines (#3405). Importing the module
    // must therefore leave both packages unloaded.
    const browserModule = await import("../browser.js");

    expect(isPackageLoaded("playwright-extra")).toBe(false);
    expect(isPackageLoaded("puppeteer-extra-plugin-stealth")).toBe(false);

    // First browser use loads them. This phase also proves the
    // require.cache probe actually observes these packages, so the
    // absence assertions above cannot pass vacuously.
    await browserModule.ensureBrowserModules();

    expect(isPackageLoaded("playwright-extra")).toBe(true);
    expect(isPackageLoaded("puppeteer-extra-plugin-stealth")).toBe(true);
  });
});
