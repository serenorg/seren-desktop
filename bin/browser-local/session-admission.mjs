// ABOUTME: Provides FIFO admission control for concurrent local Claude sessions.
// ABOUTME: Keeps active capacity bounded and exposes queue state for runtime status events.

// A queued request must give up before its caller does. Otherwise the caller
// abandons the spawn, capacity frees later, and the queue admits a session
// nobody owns — an invisible CLI process holding a slot until app restart.
// The provider_spawn RPC gives up at 120s (src/services/providers.ts).
const DEFAULT_ACQUIRE_TIMEOUT_MS = 110_000;

export function createAdmissionGate({ limit, onQueued, acquireTimeoutMs } = {}) {
  const normalizedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : 1;
  const normalizedTimeout =
    Number.isFinite(Number(acquireTimeoutMs)) && Number(acquireTimeoutMs) > 0
      ? Math.floor(Number(acquireTimeoutMs))
      : DEFAULT_ACQUIRE_TIMEOUT_MS;
  const active = new Set();
  const pending = [];

  function takePending(sessionId) {
    const index = pending.findIndex(
      (request) => request.sessionId === sessionId,
    );
    if (index === -1) return null;
    const [request] = pending.splice(index, 1);
    return request ?? null;
  }

  function drain() {
    while (active.size < normalizedLimit && pending.length > 0) {
      const request = pending.shift();
      if (!request) return;
      request.clearTimer();
      if (active.has(request.sessionId)) {
        request.resolve();
        continue;
      }
      active.add(request.sessionId);
      request.resolve();
    }
  }

  function acquire(sessionId) {
    if (active.has(sessionId)) {
      return Promise.resolve();
    }

    const existing = pending.find((request) => request.sessionId === sessionId);
    if (existing) {
      return existing.promise;
    }

    if (active.size < normalizedLimit) {
      active.add(sessionId);
      return Promise.resolve();
    }

    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    let timer = null;
    const request = {
      sessionId,
      promise,
      resolve: () => resolveRequest(),
      reject: (error) => rejectRequest(error),
      clearTimer() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
    timer = setTimeout(() => {
      timer = null;
      if (!takePending(sessionId)) return;
      request.reject(
        new Error(
          `Timed out after ${normalizedTimeout}ms waiting for a local Claude session slot`,
        ),
      );
    }, normalizedTimeout);
    if (typeof timer.unref === "function") timer.unref();
    pending.push(request);
    try {
      onQueued?.(sessionId, pending.length);
    } catch {
      // Queue telemetry must never prevent a session from waiting for capacity.
    }
    return promise;
  }

  // Releases an admitted session. A session that is still queued is cancelled
  // instead, so an abandoned spawn can never be admitted after the fact.
  function release(sessionId) {
    const queued = takePending(sessionId);
    if (queued) {
      queued.clearTimer();
      queued.reject(
        new Error(`Admission request cancelled for session ${sessionId}`),
      );
      drain();
      return true;
    }
    if (!active.delete(sessionId)) {
      return false;
    }
    drain();
    return true;
  }

  return {
    acquire,
    release,
    pendingCount() {
      return pending.length;
    },
    activeCount() {
      return active.size;
    },
    limit: normalizedLimit,
    // The gate is the only correct account of who holds a slot. Anything that
    // needs to reason about capacity must read it from here rather than infer
    // it from a session list somewhere else (#3727).
    activeIds() {
      return Array.from(active);
    },
    pendingIds() {
      return pending.map((request) => request.sessionId);
    },
  };
}
