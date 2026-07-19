// ABOUTME: Defines the provider-neutral session seam used by the Happy adapter.
// ABOUTME: It contains contracts only so protocol code cannot leak into providers.

/**
 * @typedef {{sessionId: string, agentType: string, cwd: string, status?: string, title?: string, createdAt?: string, agentSessionId?: string, pendingPermissions?: unknown[]}} SessionSummary
 * @typedef {{kind: string, sessionId: string, payload: Record<string, unknown>}} SessionEvent
 * @typedef {{agentType: string, cwd: string, title?: string, localSessionId?: string, resumeAgentSessionId?: string, sandboxMode?: string, approvalPolicy?: string, networkEnabled?: boolean, timeoutSecs?: number, initialModelId?: string, reasoningEffort?: string, permissionMode?: string}} SpawnSpec
 * @typedef {{machineName: string, agents: unknown[], roots: string[]}} Advertisement
 * @typedef {Object} SessionSource
 * @property {() => Promise<SessionSummary[]>} listSessions
 * @property {(listener: (event: SessionEvent) => void) => (() => void)} subscribe
 * @property {(sessionId: string, text: string) => Promise<void>} sendPrompt
 * @property {(sessionId: string) => Promise<void>} cancel
 * @property {(sessionId: string, requestId: string, optionId: string) => Promise<{ok: boolean}>} respondToPermission
 * @property {(sessionId: string, mode: string) => Promise<void>} setPermissionMode
 * @property {(spec: SpawnSpec) => Promise<SessionSummary>} spawn
 * @property {() => Promise<Advertisement>} advertise
 */

export {};
