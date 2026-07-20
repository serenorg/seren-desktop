// ABOUTME: Validates remote spawn roots and permission responses at the bridge boundary.
// ABOUTME: Canonical equality is required so path tricks cannot widen authority.

import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

function canonicalAbsolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    return null;
  }

  try {
    return realpathSync(value.normalize("NFC")).normalize("NFC");
  } catch {
    return null;
  }
}

/**
 * A symlink is allowed when its canonical target is exactly an advertised
 * root. This preserves the advertised-root boundary without allowing a
 * symlink to escape it.
 *
 * @param {string} requestedPath
 * @param {string[]} advertisedRoots
 * @returns {{ok: true, root: string} | {ok: false, reason: string}}
 */
export function validateSpawnRoot(requestedPath, advertisedRoots) {
  if (!Array.isArray(advertisedRoots) || advertisedRoots.length === 0) {
    return { ok: false, reason: "no advertised roots" };
  }

  if (typeof requestedPath !== "string" || !isAbsolute(requestedPath)) {
    return { ok: false, reason: "requested path must be absolute" };
  }

  const requestedRoot = canonicalAbsolutePath(requestedPath);
  if (!requestedRoot) {
    return { ok: false, reason: "requested path does not exist" };
  }

  for (const advertisedRoot of advertisedRoots) {
    const canonicalRoot = canonicalAbsolutePath(advertisedRoot);
    if (canonicalRoot === requestedRoot) {
      return { ok: true, root: canonicalRoot };
    }
  }

  return { ok: false, reason: "requested path is not an advertised root" };
}

/**
 * Visibility scope for an existing session. Spawning requires the requested path
 * to *be* an advertised root; a session already running inside one is in scope
 * too, since the user shared that folder. Both sides are canonicalized first so
 * a symlink cannot smuggle a path in, and the boundary check requires a
 * separator so `/srv/project-secret` is not treated as inside `/srv/project`.
 *
 * @param {string} sessionCwd
 * @param {string[]} advertisedRoots
 * @returns {boolean}
 */
export function isWithinAdvertisedRoots(sessionCwd, advertisedRoots) {
  if (!Array.isArray(advertisedRoots) || advertisedRoots.length === 0) {
    return false;
  }

  const canonicalCwd = canonicalAbsolutePath(sessionCwd);
  if (!canonicalCwd) {
    return false;
  }

  for (const advertisedRoot of advertisedRoots) {
    const canonicalRoot = canonicalAbsolutePath(advertisedRoot);
    if (!canonicalRoot) continue;
    if (canonicalCwd === canonicalRoot) return true;
    const boundary = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
    if (canonicalCwd.startsWith(boundary)) return true;
  }

  return false;
}

function containsValue(collection, value) {
  if (collection instanceof Set) return collection.has(value);
  if (Array.isArray(collection)) return collection.includes(value);
  return Boolean(collection && Object.hasOwn(collection, value) && collection[value]);
}

function pendingRequestFor(trackedState, sessionId, requestId) {
  const requests = trackedState?.pendingRequests;
  if (requests instanceof Map) {
    const sessionRequests = requests.get(sessionId);
    return sessionRequests instanceof Map
      ? sessionRequests.get(requestId)
      : sessionRequests && Object.hasOwn(sessionRequests, requestId)
        ? sessionRequests[requestId]
        : undefined;
  }
  if (!requests || !Object.hasOwn(requests, sessionId)) return undefined;
  const sessionRequests = requests[sessionId];
  return sessionRequests && Object.hasOwn(sessionRequests, requestId)
    ? sessionRequests[requestId]
    : undefined;
}

/**
 * @param {string} sessionId
 * @param {string} requestId
 * @param {string} optionId
 * @param {{liveSessions?: Set<string>|string[]|Object, pendingRequests?: Object|Map}} trackedState
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validatePermissionResponse(
  sessionId,
  requestId,
  optionId,
  trackedState,
) {
  if (!containsValue(trackedState?.liveSessions, sessionId)) {
    return { ok: false, reason: "session is not live" };
  }

  const pending = pendingRequestFor(trackedState, sessionId, requestId);
  if (!pending) {
    return { ok: false, reason: "permission request is not pending" };
  }

  const offeredOptions = pending.optionIds ?? pending.options ?? [];
  const offeredIds = Array.from(offeredOptions, (option) =>
    typeof option === "string" ? option : (option?.optionId ?? option?.id),
  );
  if (!offeredIds.includes(optionId)) {
    return { ok: false, reason: "permission option was not offered" };
  }

  return { ok: true };
}
