// ABOUTME: Routes one session-source facade across the provider runtime and terminal panes.
// ABOUTME: Ownership is learned from listings and events; the provider stays the default.

/**
 * The Happy layer holds exactly one source. Terminal panes and provider
 * sessions have disjoint id spaces, so this fans out the collection calls and
 * routes every per-session call to whichever source claimed that id.
 *
 * The provider is the fallback for an unknown id: it owns spawning, so a
 * session this has never listed is always one the provider just created.
 *
 * @param {{provider: object, terminal: object, debugLog?: (message: string) => void}} options
 */
export function createCompositeSource({ provider, terminal, debugLog = () => {} }) {
  const terminalSessionIds = new Set();

  const sourceFor = (sessionId) =>
    terminalSessionIds.has(sessionId) ? terminal : provider;

  return {
    async listSessions() {
      const [providerSessions, terminalSessions] = await Promise.all([
        provider.listSessions(),
        terminal.listSessions().catch((error) => {
          // A terminal listing failure must not blank the provider sessions the
          // phone is already using.
          debugLog(`terminal session listing failed: ${error}`);
          return [];
        }),
      ]);
      terminalSessionIds.clear();
      for (const session of terminalSessions) terminalSessionIds.add(session.sessionId);
      return [...providerSessions, ...terminalSessions];
    },

    subscribe(onEvent) {
      const unsubscribeProvider = provider.subscribe(onEvent);
      const unsubscribeTerminal = terminal.subscribe((event) => {
        terminalSessionIds.add(event.sessionId);
        onEvent(event);
      });
      return () => {
        unsubscribeProvider?.();
        unsubscribeTerminal?.();
      };
    },

    sendPrompt: (sessionId, text) => sourceFor(sessionId).sendPrompt(sessionId, text),
    cancel: (sessionId) => sourceFor(sessionId).cancel(sessionId),
    terminate: (sessionId) => sourceFor(sessionId).terminate(sessionId),
    respondToPermission: (sessionId, requestId, optionId) =>
      sourceFor(sessionId).respondToPermission(sessionId, requestId, optionId),
    respondToDiffProposal: (sessionId, proposalId, accepted) =>
      sourceFor(sessionId).respondToDiffProposal(sessionId, proposalId, accepted),
    setPermissionMode: (sessionId, mode) => sourceFor(sessionId).setPermissionMode(sessionId, mode),

    // Spawning and machine capabilities are the provider's alone: a terminal
    // pane is opened from the desktop, never from the phone.
    spawn: (spec) => provider.spawn(spec),
    advertise: () => provider.advertise(),

    close() {
      terminal.close?.();
    },
  };
}
