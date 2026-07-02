// ABOUTME: Per-thread OAuth account selection for multi-account publishers.
// ABOUTME: Keeps Settings, chat header, approvals, and gateway dispatch in sync.

import { createSignal } from "solid-js";
import type { UserOAuthConnectionResponse } from "@/api";

export type OAuthConnection = UserOAuthConnectionResponse & {
  is_default?: boolean;
};

type ThreadConnectionSelections = Record<string, Record<string, string>>;

const STORAGE_KEY = "seren.oauth.thread-connection-selections.v1";

function getStorage(): Storage | null {
  if (typeof globalThis === "undefined") return null;
  try {
    return "localStorage" in globalThis ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

function readSelections(): ThreadConnectionSelections {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as ThreadConnectionSelections;
  } catch {
    return {};
  }
}

function writeSelections(selections: ThreadConnectionSelections): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(selections));
  } catch {
    // Ignore storage quota/private-mode failures; current session state still works.
  }
}

function normalizeProviderSlug(providerSlug: string): string {
  return providerSlug.trim().toLowerCase();
}

function normalizeThreadId(threadId: string | null | undefined): string | null {
  const trimmed = threadId?.trim();
  return trimmed ? trimmed : null;
}

const [selections, setSelections] = createSignal<ThreadConnectionSelections>(
  readSelections(),
);
const [connectionsRevision, setConnectionsRevision] = createSignal(0);

export const oauthConnectionsRevision = connectionsRevision;

export function markOAuthConnectionsChanged(): void {
  setConnectionsRevision((revision) => revision + 1);
}

export function getOAuthConnectionsForProvider(
  connections: OAuthConnection[],
  providerSlug: string,
): OAuthConnection[] {
  const normalizedProvider = normalizeProviderSlug(providerSlug);
  return connections
    .filter(
      (connection) =>
        connection.provider_slug.toLowerCase() === normalizedProvider &&
        connection.is_valid,
    )
    .sort(
      (a, b) => Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)),
    );
}

export function getDefaultOAuthConnection(
  connections: OAuthConnection[],
): OAuthConnection | null {
  return connections.find((connection) => connection.is_default) ?? null;
}

export function getThreadOAuthConnectionId(
  threadId: string | null | undefined,
  providerSlug: string,
): string | null {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) return null;
  return (
    selections()[normalizedThreadId]?.[normalizeProviderSlug(providerSlug)] ??
    null
  );
}

export function setThreadOAuthConnectionId(
  threadId: string | null | undefined,
  providerSlug: string,
  connectionId: string | null,
): void {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId) return;

  const normalizedProvider = normalizeProviderSlug(providerSlug);
  const next: ThreadConnectionSelections = {
    ...selections(),
    [normalizedThreadId]: {
      ...(selections()[normalizedThreadId] ?? {}),
    },
  };

  if (connectionId) {
    next[normalizedThreadId][normalizedProvider] = connectionId;
  } else {
    delete next[normalizedThreadId][normalizedProvider];
    if (Object.keys(next[normalizedThreadId]).length === 0) {
      delete next[normalizedThreadId];
    }
  }

  setSelections(next);
  writeSelections(next);
}

export function resolveThreadOAuthConnection(
  threadId: string | null | undefined,
  providerSlug: string,
  allConnections: OAuthConnection[],
): OAuthConnection | null {
  const validConnections = getOAuthConnectionsForProvider(
    allConnections,
    providerSlug,
  );
  const selectedId = getThreadOAuthConnectionId(threadId, providerSlug);
  const selected = selectedId
    ? validConnections.find((connection) => connection.id === selectedId)
    : null;
  if (selected) return selected;

  const defaultConnection = getDefaultOAuthConnection(validConnections);
  if (defaultConnection) return defaultConnection;

  return validConnections.length === 1 ? validConnections[0] : null;
}

export function hasAmbiguousOAuthConnections(
  threadId: string | null | undefined,
  providerSlug: string,
  allConnections: OAuthConnection[],
): boolean {
  const validConnections = getOAuthConnectionsForProvider(
    allConnections,
    providerSlug,
  );
  if (validConnections.length <= 1) return false;
  return !resolveThreadOAuthConnection(threadId, providerSlug, allConnections);
}

export function formatOAuthConnectionLabel(
  connection: OAuthConnection,
): string {
  return (
    connection.provider_email ||
    connection.provider_user_id ||
    `${connection.provider_slug} account`
  );
}
