// ABOUTME: Defines the machine-facing session seam used by the remote bridge.
// ABOUTME: Keeps provider and future relay types separated by neutral shapes.

/**
 * @typedef {Object} SessionSummary
 * @property {string} sessionId
 * @property {string} agentType
 * @property {string} cwd
 * @property {string} status
 * @property {string} createdAt
 * @property {string=} agentSessionId
 * @property {Array<Object>=} pendingPermissions
 */

/**
 * @typedef {Object} SessionEvent
 * @property {string} kind
 * @property {string} sessionId
 * @property {Object} payload
 */

/**
 * @typedef {Object} RespondResult
 * @property {boolean} ok
 */

/**
 * @typedef {Object} SpawnSpec
 * @property {string} agentType
 * @property {string} cwd
 * @property {string=} title
 * @property {string=} localSessionId
 * @property {string=} resumeAgentSessionId
 * @property {string=} sandboxMode
 * @property {string=} approvalPolicy
 * @property {boolean=} networkEnabled
 * @property {number=} timeoutSecs
 * @property {string=} initialModelId
 * @property {string=} reasoningEffort
 */

/**
 * @typedef {Object} Advertisement
 * @property {string} machineName
 * @property {Array<Object>} agents
 * @property {string[]} roots
 */

/**
 * @typedef {Object} SessionSource
 * @property {() => Promise<SessionSummary[]>} listSessions
 * @property {(onEvent: (evt: SessionEvent) => void) => () => void} subscribe
 * @property {(sessionId: string, text: string) => Promise<void>} sendPrompt
 * @property {(sessionId: string) => Promise<void>} cancel
 * @property {(sessionId: string, requestId: string, optionId: string) => Promise<RespondResult>} respondToPermission
 * @property {(spec: SpawnSpec) => Promise<SessionSummary>} spawn
 * @property {() => Promise<Advertisement>} advertise
 */
