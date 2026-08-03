// ABOUTME: Host-owned, per-thread Gmail sender confirmation checkpoints.
// ABOUTME: Prevents a model-provided OAuth selector from authorizing a same-turn send.

interface PendingGmailSenderConfirmation {
  preparedAtUserTurnId: string;
  verifiedConnectionId: string;
}

interface GmailSenderConfirmation {
  confirmedConnectionId?: string;
  pending?: PendingGmailSenderConfirmation;
}

type GmailSenderConfirmations = Record<string, GmailSenderConfirmation>;

const STORAGE_KEY = "seren.oauth.gmail-send-confirmations.v1";

function getStorage(): Storage | null {
  if (typeof globalThis === "undefined") return null;
  try {
    return "localStorage" in globalThis ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readConfirmations(): GmailSenderConfirmations {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as GmailSenderConfirmations)
      : {};
  } catch {
    return {};
  }
}

let confirmations = readConfirmations();

function writeConfirmations(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(confirmations));
  } catch {
    // Current-session state remains authoritative when storage is unavailable.
  }
}

/**
 * Record a successful, explicitly routed Gmail profile read. The first such
 * read opens a checkpoint on the current human turn. Re-verifying another
 * listed account after the user's reply keeps the original checkpoint while
 * binding the eventual send to the newly verified connection.
 */
export function noteGmailSenderProfileVerified(
  threadId: string | null | undefined,
  connectionId: string | null | undefined,
  userTurnId: string | null | undefined,
): void {
  const thread = nonEmpty(threadId);
  const connection = nonEmpty(connectionId);
  const turn = nonEmpty(userTurnId);
  if (!thread || !connection || !turn) return;

  const current = confirmations[thread] ?? {};
  if (current.confirmedConnectionId === connection) return;
  confirmations = {
    ...confirmations,
    [thread]: {
      ...current,
      pending: {
        preparedAtUserTurnId: current.pending?.preparedAtUserTurnId ?? turn,
        verifiedConnectionId: connection,
      },
    },
  };
  writeConfirmations();
}

/**
 * A first send is eligible only after a successful profile read and a later
 * human-authored turn. A model can copy every visible connection_id and still
 * cannot advance this checkpoint itself.
 */
export function hasConfirmedGmailSenderForTurn(
  threadId: string | null | undefined,
  connectionId: string | null | undefined,
  userTurnId: string | null | undefined,
): boolean {
  const thread = nonEmpty(threadId);
  const connection = nonEmpty(connectionId);
  const turn = nonEmpty(userTurnId);
  if (!thread || !connection || !turn) return false;

  const current = confirmations[thread];
  if (current?.confirmedConnectionId === connection) return true;
  return Boolean(
    current?.pending?.verifiedConnectionId === connection &&
      current.pending.preparedAtUserTurnId !== turn,
  );
}

/** Mark the selected sender durable only after the external send succeeds. */
export function markGmailSenderConfirmed(
  threadId: string | null | undefined,
  connectionId: string | null | undefined,
): void {
  const thread = nonEmpty(threadId);
  const connection = nonEmpty(connectionId);
  if (!thread || !connection) return;
  confirmations = {
    ...confirmations,
    [thread]: { confirmedConnectionId: connection },
  };
  writeConfirmations();
}

export function resetGmailSenderConfirmationsForTests(): void {
  confirmations = {};
  const storage = getStorage();
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Test state is already reset in memory.
  }
}
