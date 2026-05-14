// ABOUTME: Browser for org-scoped agent catalog entries with create/edit/delete actions.
// ABOUTME: Loads via agentCatalog service; renders entries grouped by kind.

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { CatalogEntryModal } from "@/components/catalog/CatalogEntryModal";
import { ConfirmDialog } from "@/components/catalog/ConfirmDialog";
import { getDefaultOrganizationId } from "@/lib/tauri-bridge";
import {
  agentCatalog,
  type CatalogEntry,
  type CatalogEntryKind,
} from "@/services/agent-catalog";

const KIND_LABEL: Record<CatalogEntryKind, string> = {
  agent: "Agent",
  skill: "Skill",
  mcp_server: "MCP server",
  prompt: "Prompt",
  runtime_policy: "Runtime policy",
};

const KIND_OPTIONS: { value: CatalogEntryKind | ""; label: string }[] = [
  { value: "", label: "All kinds" },
  { value: "agent", label: "Agent" },
  { value: "skill", label: "Skill" },
  { value: "mcp_server", label: "MCP server" },
  { value: "prompt", label: "Prompt" },
  { value: "runtime_policy", label: "Runtime policy" },
];

function formatDate(value: string): string {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString();
}

export const CatalogList: Component = () => {
  const [kindFilter, setKindFilter] = createSignal<CatalogEntryKind | "">("");
  const [includeDeprecated, setIncludeDeprecated] = createSignal(false);
  const [orgId, setOrgId] = createSignal<string | null>(null);
  const [refreshNonce, setRefreshNonce] = createSignal(0);
  const [editing, setEditing] = createSignal<CatalogEntry | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [pendingDelete, setPendingDelete] = createSignal<CatalogEntry | null>(
    null,
  );
  const [deleting, setDeleting] = createSignal(false);

  const [entries] = createResource(
    () => ({
      kind: kindFilter() || undefined,
      includeDeprecated: includeDeprecated(),
      nonce: refreshNonce(),
    }),
    async (params): Promise<CatalogEntry[]> => {
      const id = await getDefaultOrganizationId();
      setOrgId(id);
      if (!id) return [];
      return agentCatalog.list(id, {
        kind: params.kind,
        includeDeprecated: params.includeDeprecated,
      });
    },
  );

  const grouped = createMemo(() => {
    const list = entries() ?? [];
    const byKind = new Map<CatalogEntryKind, CatalogEntry[]>();
    for (const entry of list) {
      const bucket = byKind.get(entry.kind) ?? [];
      bucket.push(entry);
      byKind.set(entry.kind, bucket);
    }
    for (const bucket of byKind.values()) {
      bucket.sort((a, b) => {
        const ns = a.namespace.localeCompare(b.namespace);
        if (ns !== 0) return ns;
        const n = a.name.localeCompare(b.name);
        if (n !== 0) return n;
        return b.version.localeCompare(a.version);
      });
    }
    return Array.from(byKind.entries()).sort(([a], [b]) => a.localeCompare(b));
  });

  const handleDelete = (entry: CatalogEntry) => {
    setActionError(null);
    setPendingDelete(entry);
  };

  const confirmDelete = async () => {
    const id = orgId();
    const entry = pendingDelete();
    if (!id || !entry) return;
    setDeleting(true);
    try {
      await agentCatalog.delete(id, entry.id);
      setRefreshNonce((n) => n + 1);
      setPendingDelete(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div class="flex flex-col gap-4 p-5">
      <header class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 class="m-0 text-lg font-semibold text-foreground">
            Agent catalog
          </h1>
          <p class="mt-1 text-[12px] text-muted-foreground">
            Versioned, tagged artifacts available to your organization.
          </p>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <label
            for="catalog-kind-filter"
            class="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70"
          >
            Kind
          </label>
          <select
            id="catalog-kind-filter"
            class="py-1.5 px-2 bg-card text-foreground border border-border rounded text-[13px] focus:outline-none focus:border-primary"
            value={kindFilter()}
            onChange={(event) =>
              setKindFilter(event.currentTarget.value as CatalogEntryKind | "")
            }
          >
            <For each={KIND_OPTIONS}>
              {(option) => <option value={option.value}>{option.label}</option>}
            </For>
          </select>
          <label class="flex items-center gap-1.5 text-[12px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={includeDeprecated()}
              onChange={(event) =>
                setIncludeDeprecated(event.currentTarget.checked)
              }
            />
            Show deprecated
          </label>
          <button
            type="button"
            class="py-1.5 px-3 rounded text-[12px] font-medium cursor-pointer bg-primary text-primary-foreground border border-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => setCreating(true)}
            disabled={!orgId()}
          >
            New entry
          </button>
        </div>
      </header>

      <Show when={entries.loading}>
        <div class="text-[13px] text-muted-foreground">Loading catalog...</div>
      </Show>
      <Show when={entries.error}>
        <div class="text-[13px] text-red-400" role="status" aria-live="polite">
          Failed to load catalog: {String(entries.error)}
        </div>
      </Show>
      <Show when={actionError()}>
        <div class="text-[13px] text-red-400" role="status" aria-live="polite">
          {actionError()}
        </div>
      </Show>
      <Show
        when={
          !entries.loading && !entries.error && (entries() ?? []).length === 0
        }
      >
        <div class="text-[13px] text-muted-foreground">
          No catalog entries yet.
        </div>
      </Show>

      <For each={grouped()}>
        {([kind, items]) => (
          <section class="border border-border rounded">
            <header class="px-3 py-2 bg-muted/30 text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {KIND_LABEL[kind]} ({items.length})
            </header>
            <ul class="divide-y divide-border">
              <For each={items}>
                {(entry) => (
                  <li class="px-3 py-2 grid grid-cols-[1fr_auto] gap-3 items-baseline">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-mono text-[13px] text-foreground truncate">
                          {entry.namespace}/{entry.name}
                        </span>
                        <span class="text-[11px] text-muted-foreground font-mono">
                          {entry.version}
                        </span>
                        <Show when={entry.tag}>
                          <span class="inline-flex items-center px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-900 text-[10px] font-medium">
                            {entry.tag}
                          </span>
                        </Show>
                        <Show when={entry.deprecated}>
                          <span class="inline-flex items-center px-1.5 py-0.5 rounded border border-slate-300 bg-slate-100 text-slate-700 text-[10px] font-medium">
                            deprecated
                          </span>
                        </Show>
                      </div>
                      <Show when={entry.description}>
                        <div class="mt-0.5 text-[12px] text-muted-foreground line-clamp-2">
                          {entry.description}
                        </div>
                      </Show>
                    </div>
                    <div class="flex items-center gap-3 text-[11px] text-muted-foreground whitespace-nowrap">
                      <span>{formatDate(entry.updated_at)}</span>
                      <button
                        type="button"
                        class="text-[12px] text-foreground/80 hover:text-foreground underline-offset-2 hover:underline cursor-pointer"
                        onClick={() => setEditing(entry)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        class="text-[12px] text-red-500 hover:text-red-400 underline-offset-2 hover:underline cursor-pointer"
                        onClick={() => handleDelete(entry)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </For>

      <Show when={creating() && orgId()}>
        {(_) => (
          <CatalogEntryModal
            organizationId={orgId() as string}
            onClose={() => setCreating(false)}
            onSaved={() => setRefreshNonce((n) => n + 1)}
          />
        )}
      </Show>
      <Show when={editing()}>
        {(entry) => (
          <CatalogEntryModal
            organizationId={orgId() as string}
            entry={entry()}
            onClose={() => setEditing(null)}
            onSaved={() => setRefreshNonce((n) => n + 1)}
          />
        )}
      </Show>
      <ConfirmDialog
        open={pendingDelete() !== null}
        title="Delete catalog entry"
        message={
          pendingDelete()
            ? `Delete ${pendingDelete()?.namespace}/${pendingDelete()?.name}@${pendingDelete()?.version}? This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        destructive
        pending={deleting()}
        onConfirm={confirmDelete}
        onCancel={() => {
          if (!deleting()) setPendingDelete(null);
        }}
      />
    </div>
  );
};
