// ABOUTME: Provider-runtime filesystem policy shared by local model and CLI adapters.
// ABOUTME: Canonicalizes paths before deciding whether access stays inside the active project.

import {
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const FILE_READ_TOOLS = new Set([
  "read_file",
  "read_file_base64",
  "list_directory",
  "path_exists",
]);

export const FILE_WRITE_TOOLS = new Set([
  "write_file",
  "write_pdf_from_html",
  "create_directory",
]);

export function fileAccessKind(toolName) {
  if (FILE_READ_TOOLS.has(toolName)) return "read";
  if (FILE_WRITE_TOOLS.has(toolName)) return "write";
  return null;
}

function hasParentTraversal(requested) {
  return String(requested)
    .replaceAll("\\", "/")
    .split("/")
    .includes("..");
}

function expandHome(requested) {
  if (requested === "~") return os.homedir();
  if (requested.startsWith("~/") || requested.startsWith("~\\")) {
    return path.join(os.homedir(), requested.slice(2));
  }
  return requested;
}

function canonicalizeExistingOrParent(candidate) {
  if (existsSync(candidate)) return realpathSync.native(candidate);

  const missing = [];
  let ancestor = candidate;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error("File access denied: path has no existing ancestor.");
    }
    missing.push(path.basename(ancestor));
    ancestor = parent;
  }

  let resolved = realpathSync.native(ancestor);
  for (const component of missing.reverse()) {
    resolved = path.join(resolved, component);
  }
  return resolved;
}

export function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isSensitivePath(candidate) {
  const home = os.homedir();
  const sensitiveDirectories = [
    ".ssh",
    ".aws",
    ".gnupg",
    ".seren",
    path.join(".config", "seren"),
    path.join(".config", "gcloud"),
    path.join(".config", "autostart"),
    path.join("Library", "LaunchAgents"),
  ].map((entry) => path.join(home, entry));
  if (sensitiveDirectories.some((entry) => pathIsWithin(candidate, entry))) {
    return true;
  }

  return new Set([
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".gitconfig",
    ".npmrc",
    ".netrc",
  ]).has(path.basename(candidate).toLowerCase());
}

function grantDirectory(candidate, kind) {
  if (kind === "read" && existsSync(candidate)) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // The canonical path will be revalidated when the operation executes.
    }
  }
  return path.dirname(candidate);
}

export function evaluateFileAccess({
  requestedPath,
  projectRoot,
  kind,
  sandboxMode = "workspace-write",
  approvalPolicy = "on-request",
  autoApproveReads = true,
}) {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    requestedPath.includes("\0") ||
    hasParentTraversal(requestedPath)
  ) {
    return { decision: "deny", reason: "File access denied: invalid path." };
  }

  let canonicalRoot;
  let resolvedPath;
  try {
    canonicalRoot = projectRoot
      ? realpathSync.native(path.resolve(expandHome(projectRoot)))
      : null;
    const expanded = expandHome(requestedPath);
    const candidate = path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : canonicalRoot
        ? path.resolve(canonicalRoot, expanded)
        : null;
    if (!candidate) {
      return {
        decision: "deny",
        reason: "File access denied: choose a project folder first.",
      };
    }
    resolvedPath = canonicalizeExistingOrParent(candidate);
  } catch {
    return {
      decision: "deny",
      reason: "File access denied: path could not be resolved.",
    };
  }

  const access = {
    resolvedPath,
    grantDirectory: grantDirectory(resolvedPath, kind),
    kind,
    sensitive: isSensitivePath(resolvedPath),
  };
  const fullAccess =
    sandboxMode === "full-access" || sandboxMode === "danger-full-access";
  if (fullAccess) return { decision: "allow", ...access };

  if (kind === "write" && sandboxMode === "read-only") {
    return {
      decision: "deny",
      reason: "File write denied: Agent Sandbox Mode is Read Only.",
      ...access,
    };
  }

  const inProject = canonicalRoot
    ? pathIsWithin(resolvedPath, canonicalRoot)
    : false;
  if (inProject && !access.sensitive) {
    if (kind !== "read" || autoApproveReads) {
      return { decision: "allow", ...access };
    }
  }

  if (approvalPolicy === "on-request" || approvalPolicy === "untrusted") {
    return { decision: "require_approval", ...access };
  }
  return {
    decision: "deny",
    reason:
      "File access denied by the active project scope. Select Full Access to allow external files.",
    ...access,
  };
}
