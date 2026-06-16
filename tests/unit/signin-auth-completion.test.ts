// ABOUTME: Regression coverage for sign-in surfaces completing auth state setup.
// ABOUTME: Prevents UI from closing while authStore.isAuthenticated is still false.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");

function readSource(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("SignIn auth completion", () => {
  it("awaits the success callback before leaving the completing phase", () => {
    const source = readSource("src/components/auth/SignIn.tsx");

    expect(source).toContain("onSuccess: () => Promise<void> | void;");
    expect(source).toContain("await props.onSuccess();");
    expect(source).toContain("setError(");
    expect(source).toContain('setPhase("credentials")');
  });

  it("surfaces raw Tauri string errors instead of only Error instances", () => {
    const source = readSource("src/components/auth/SignIn.tsx");

    expect(source).toContain('typeof err === "string"');
    expect(source).toContain('authErrorMessage(err, "Social sign-in failed")');
    expect(source).toContain('authErrorMessage(err, "Login failed")');
    expect(source).toContain('authErrorMessage(err, "Sign-in setup failed")');
  });

  it("main account sign-in waits for authStore activation before closing", () => {
    const appSource = readSource("src/App.tsx");
    const shellSource = readSource("src/components/layout/AppShell.tsx");

    expect(appSource).toContain("const handleLoginSuccess = async () =>");
    expect(appSource).toContain("await setAuthenticated(");
    expect(shellSource).toContain("const handleLoginSuccess = async () =>");
    expect(shellSource).toContain("await props.onLoginSuccess();");
    const handlerStart = shellSource.indexOf(
      "const handleLoginSuccess = async () =>",
    );
    const handlerBody = shellSource.slice(handlerStart, handlerStart + 160);
    expect(handlerBody.indexOf("await props.onLoginSuccess();")).toBeLessThan(
      handlerBody.indexOf("setSlidePanel(null);"),
    );
  });

  it("modal and chat sign-in surfaces restore auth state before dismissing", () => {
    const modalSource = readSource("src/components/auth/SessionExpiredModal.tsx");
    const chatSource = readSource("src/components/chat/ChatContent.tsx");

    expect(modalSource).toContain("restoreAuthenticatedSession");
    expect(modalSource).toContain("await restoreAuthenticatedSession();");
    expect(modalSource.indexOf("await restoreAuthenticatedSession();")).toBeLessThan(
      modalSource.indexOf("dismissSignInModal();"),
    );
    expect(chatSource).toContain("await checkAuth();");
    expect(chatSource.indexOf("await checkAuth();")).toBeLessThan(
      chatSource.indexOf("setShowSignInPrompt(false);"),
    );
  });
});
