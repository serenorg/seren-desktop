// ABOUTME: Resolves a bounded session's OS sandbox launch spec from the trusted app binary.
// ABOUTME: A provider_spawn caller can never supply or widen the spec; failure blocks the launch.

import { execFileSync } from "node:child_process";

const SPEC_ARGUMENT = "__seren-sandbox-spec";
const SPEC_TIMEOUT_MS = 15_000;

/** A full-access session is an explicit user opt-in and carries no OS profile. */
function isFullAccess(sandboxMode) {
  return sandboxMode === "full-access" || sandboxMode === "danger-full-access";
}

/**
 * The runtime only accepts the three shapes the Rust builder emits. Anything
 * else — including a hand-written profile that would widen the boundary — is
 * rejected rather than passed through to the launcher.
 */
function assertKnownSpecShape(spec) {
  const nonEmpty = (value) =>
    typeof value === "string" && value.trim().length > 0;

  if (spec?.kind === "seatbelt" && nonEmpty(spec.profile)) return;
  if (
    (spec?.kind === "linux-launcher" || spec?.kind === "windows-launcher") &&
    nonEmpty(spec.launcherPath) &&
    nonEmpty(spec.policyBase64)
  ) {
    return;
  }

  throw new Error(
    "the app binary returned an unrecognized sandbox launch spec.",
  );
}

/**
 * Ask the signed app binary for this session's launch spec. Every bounded local
 * agent spawn resolves here regardless of which caller issued provider_spawn —
 * the desktop renderer, a paired role, an orchestrator one-shot, or the Happy
 * mobile bridge. #3230.
 *
 * Returns null only for full-access sessions. Any other failure throws so the
 * caller fails closed instead of launching unconfined.
 */
export function resolveSandboxLaunchSpec({
  sandboxMode,
  cwd,
  networkEnabled,
} = {}) {
  if (isFullAccess(sandboxMode)) return null;

  const specBinary = process.env.SEREN_SANDBOX_SPEC_BIN;
  if (typeof specBinary !== "string" || specBinary.trim().length === 0) {
    throw new Error(
      "Agent launch blocked: the trusted sandbox spec binary is unavailable.",
    );
  }

  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new Error(
      "Agent launch blocked: a bounded session requires a project root.",
    );
  }

  let stdout;
  try {
    stdout = execFileSync(
      specBinary,
      [
        SPEC_ARGUMENT,
        sandboxMode ?? "workspace-write",
        networkEnabled === false ? "false" : "true",
        cwd,
      ],
      {
        encoding: "utf8",
        timeout: SPEC_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        // Capture stderr instead of letting it reach the runtime's own stream;
        // the reason belongs in the thrown error, not in an unattributed log.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    // stderr carries the Rust builder's reason (bad mode, unresolvable root,
    // unavailable backend); surface it so the failure is diagnosable.
    const detail =
      (typeof error?.stderr === "string" ? error.stderr.trim() : "") ||
      (error instanceof Error ? error.message : String(error));
    throw new Error(
      `Agent launch blocked: the trusted sandbox launch spec failed: ${detail}`,
    );
  }

  let spec;
  try {
    spec = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      "Agent launch blocked: the trusted sandbox launch spec was not valid JSON.",
    );
  }

  try {
    assertKnownSpecShape(spec);
  } catch (error) {
    throw new Error(`Agent launch blocked: ${error.message}`);
  }

  return spec;
}
