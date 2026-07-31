// ABOUTME: Provides FIFO admission control for concurrent local Claude sessions.
// ABOUTME: Keeps active capacity bounded and exposes queue state for runtime status events.

export function createAdmissionGate({ limit, onQueued } = {}) {
  const normalizedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : 1;
  const active = new Set();
  const pending = [];

  function drain() {
    while (active.size < normalizedLimit && pending.length > 0) {
      const request = pending.shift();
      if (!request) return;
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
    const promise = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    const request = {
      sessionId,
      promise,
      resolve: resolveRequest,
    };
    pending.push(request);
    try {
      onQueued?.(sessionId, pending.length);
    } catch {
      // Queue telemetry must never prevent a session from waiting for capacity.
    }
    return promise;
  }

  function release(sessionId) {
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
  };
}
