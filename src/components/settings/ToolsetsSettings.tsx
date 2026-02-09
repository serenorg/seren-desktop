// ABOUTME: Settings UI for managing custom toolsets (collections of publishers).
// ABOUTME: Allows users to create, edit, and delete toolsets for workflow organization.

import {
  type Component,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { listConnections, listStorePublishers } from "@/api";
import {
  addPublisherToToolset,
  createToolset,
  deleteToolset,
  removePublisherFromToolset,
  settingsState,
  type Toolset,
  updateToolset,
} from "@/stores/settings.store";

interface Publisher {
  slug: string;
  name: string;
  logo_url: string | null;
  description: string | null;
  categories: string[];
}

export const ToolsetsSettings: Component = () => {
  const [showCreateModal, setShowCreateModal] = createSignal(false);
  const [editingToolset, setEditingToolset] = createSignal<Toolset | null>(
    null,
  );
  const [error, setError] = createSignal<string | null>(null);

  // Form state for create modal
  const [formName, setFormName] = createSignal("");
  const [formDescription, setFormDescription] = createSignal("");
  const [formPublishers, setFormPublishers] = createSignal<string[]>([]);
  const [publisherSearch, setPublisherSearch] = createSignal("");

  // Inline add publisher state
  const [addingToToolset, setAddingToToolset] = createSignal<string | null>(
    null,
  );
  const [inlineSearch, setInlineSearch] = createSignal("");

  // Fetch available publishers
  const [publishers] = createResource(async () => {
    const { data, error } = await listStorePublishers({
      query: { limit: 100 },
      throwOnError: false,
    });
    if (error) {
      console.error("[ToolsetsSettings] Error fetching publishers:", error);
      return [];
    }
    const pubs: Publisher[] = (data?.data || []).map((p) => ({
      slug: p.slug,
      name: p.name,
      logo_url: p.logo_url ?? null,
      description: p.description ?? null,
      categories: p.categories || [],
    }));
    return pubs;
  });

  // Fetch OAuth connections for status display
  const [connections] = createResource(async () => {
    const { data, error } = await listConnections({ throwOnError: false });
    if (error) return [];
    return data?.connections || [];
  });

  const getPublisherBySlug = (slug: string): Publisher | undefined => {
    return publishers()?.find((p) => p.slug === slug);
  };

  const getConnectionStatus = (
    slug: string,
  ): "connected" | "expired" | "none" => {
    const conn = connections()?.find((c) => c.provider_slug === slug);
    if (!conn) return "none";
    return conn.is_valid ? "connected" : "expired";
  };

  const openCreateModal = () => {
    setFormName("");
    setFormDescription("");
    setFormPublishers([]);
    setPublisherSearch("");
    setEditingToolset(null);
    setShowCreateModal(true);
  };

  const closeModal = () => {
    setShowCreateModal(false);
    setEditingToolset(null);
    setPublisherSearch("");
    setError(null);
  };

  // Filter publishers based on search (for create modal)
  const filteredPublishers = () => {
    const search = publisherSearch().toLowerCase().trim();
    if (!search) return publishers() || [];
    return (publishers() || []).filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        (p.description?.toLowerCase().includes(search) ?? false) ||
        p.slug.toLowerCase().includes(search) ||
        p.categories.some((c) => c.toLowerCase().includes(search)),
    );
  };

  // Filter publishers for inline add (excludes already added)
  const availablePublishersForToolset = (toolset: Toolset) => {
    const search = inlineSearch().toLowerCase().trim();
    const existing = new Set(toolset.publisherSlugs);
    return (publishers() || []).filter(
      (p) =>
        !existing.has(p.slug) &&
        (search === "" ||
          p.name.toLowerCase().includes(search) ||
          (p.description?.toLowerCase().includes(search) ?? false) ||
          p.slug.toLowerCase().includes(search) ||
          p.categories.some((c) => c.toLowerCase().includes(search))),
    );
  };

  const handleInlineAdd = async (toolsetId: string, slug: string) => {
    await addPublisherToToolset(toolsetId, slug);
    setAddingToToolset(null);
    setInlineSearch("");
  };

  const handleInlineRemove = async (toolsetId: string, slug: string) => {
    await removePublisherFromToolset(toolsetId, slug);
  };

  const handleSave = async () => {
    const name = formName().trim();
    if (!name) {
      setError("Name is required");
      return;
    }

    try {
      const editing = editingToolset();
      if (editing) {
        await updateToolset(editing.id, {
          name,
          description: formDescription().trim(),
          publisherSlugs: formPublishers(),
        });
      } else {
        await createToolset(name, formDescription().trim(), formPublishers());
      }
      closeModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save toolset");
    }
  };

  const handleDelete = async (toolset: Toolset) => {
    const confirmed = window.confirm(
      `Delete "${toolset.name}"? This cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      await deleteToolset(toolset.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete toolset");
    }
  };

  const togglePublisher = (slug: string) => {
    setFormPublishers((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
  };

  const toolsets = () => settingsState.toolsets.toolsets;

  return (
    <section>
      <div class="flex items-center justify-between mb-2">
        <h3 class="m-0 text-[1.3rem] font-semibold text-foreground">
          Toolsets
        </h3>
        <button
          type="button"
          class="px-3 py-1.5 text-sm font-medium text-white bg-accent border-none rounded cursor-pointer transition-colors duration-100 hover:bg-[#4f46e5]"
          onClick={openCreateModal}
        >
          + New Toolset
        </button>
      </div>
      <p class="m-0 mb-6 text-muted-foreground leading-normal">
        Group publishers into collections for common workflows. Toolsets help
        you organize which publishers you use together.
      </p>

      {/* Error Display */}
      <Show when={error()}>
        <div class="mb-4 px-3.5 py-2.5 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-md text-[#ef4444] text-[13px]">
          {error()}
        </div>
      </Show>

      {/* Empty State */}
      <Show when={toolsets().length === 0}>
        <div class="text-center py-10 px-6 text-muted-foreground border border-dashed border-[rgba(148,163,184,0.2)] rounded-lg">
          <span class="text-[2.5rem] block mb-3 opacity-60">📦</span>
          <p class="m-0 mb-2">No toolsets yet</p>
          <p class="m-0 text-[0.85rem]">
            Create a toolset to group publishers for your workflows.
          </p>
        </div>
      </Show>

      {/* Toolsets List */}
      <Show when={toolsets().length > 0}>
        <div class="flex flex-col gap-3">
          <For each={toolsets()}>
            {(toolset) => (
              <div class="px-4 py-4 bg-[rgba(30,30,30,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg">
                <div class="flex items-start justify-between gap-4">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <h4 class="m-0 text-base font-medium text-foreground">
                        {toolset.name}
                      </h4>
                      <span class="px-2 py-0.5 text-xs bg-[rgba(148,163,184,0.1)] text-muted-foreground rounded">
                        {toolset.publisherSlugs.length} publisher
                        {toolset.publisherSlugs.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <Show when={toolset.description}>
                      <p class="m-0 text-sm text-muted-foreground">
                        {toolset.description}
                      </p>
                    </Show>

                    {/* Publisher Pills with inline editing */}
                    <div class="flex flex-wrap gap-1.5 mt-3 items-center">
                      <For each={toolset.publisherSlugs}>
                        {(slug) => {
                          const pub = getPublisherBySlug(slug);
                          const status = getConnectionStatus(slug);
                          const statusColor =
                            status === "connected"
                              ? "bg-[rgba(34,197,94,0.2)] border-[rgba(34,197,94,0.3)]"
                              : status === "expired"
                                ? "bg-[rgba(245,158,11,0.2)] border-[rgba(245,158,11,0.3)]"
                                : "bg-[rgba(148,163,184,0.1)] border-[rgba(148,163,184,0.2)]";
                          return (
                            <span
                              class={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded border ${statusColor}`}
                              title={
                                status === "connected"
                                  ? "Connected"
                                  : status === "expired"
                                    ? "Token expired"
                                    : "Not connected"
                              }
                            >
                              {pub?.name || slug}
                              <button
                                type="button"
                                class="ml-0.5 text-muted-foreground hover:text-[#ef4444] transition-colors"
                                onClick={() =>
                                  handleInlineRemove(toolset.id, slug)
                                }
                                title="Remove publisher"
                              >
                                ×
                              </button>
                            </span>
                          );
                        }}
                      </For>

                      {/* Add Publisher Button */}
                      <div class="relative">
                        <button
                          type="button"
                          class="px-2 py-1 text-xs text-muted-foreground bg-transparent border border-dashed border-[rgba(148,163,184,0.3)] rounded cursor-pointer transition-colors hover:border-accent hover:text-accent"
                          onClick={() => {
                            setAddingToToolset(
                              addingToToolset() === toolset.id
                                ? null
                                : toolset.id,
                            );
                            setInlineSearch("");
                          }}
                          title="Add publisher"
                        >
                          +
                        </button>

                        {/* Inline Add Popup */}
                        <Show when={addingToToolset() === toolset.id}>
                          <div class="absolute left-0 top-full mt-1 z-50 w-64 bg-[#1e1e1e] border border-[rgba(148,163,184,0.3)] rounded-lg shadow-lg overflow-hidden">
                            <input
                              type="text"
                              value={inlineSearch()}
                              onInput={(e) =>
                                setInlineSearch(e.currentTarget.value)
                              }
                              placeholder="Search publishers..."
                              class="w-full px-3 py-2 bg-transparent border-b border-[rgba(148,163,184,0.2)] text-sm text-foreground focus:outline-none"
                              autofocus
                            />
                            <div class="max-h-40 overflow-y-auto">
                              <Show
                                when={
                                  availablePublishersForToolset(toolset)
                                    .length === 0
                                }
                              >
                                <div class="px-3 py-2 text-xs text-muted-foreground">
                                  {inlineSearch()
                                    ? "No matches"
                                    : "All publishers added"}
                                </div>
                              </Show>
                              <For
                                each={availablePublishersForToolset(
                                  toolset,
                                ).slice(0, 10)}
                              >
                                {(pub) => (
                                  <button
                                    type="button"
                                    class="w-full px-3 py-2 text-left text-sm text-foreground hover:bg-[rgba(148,163,184,0.1)] transition-colors"
                                    onClick={() =>
                                      handleInlineAdd(toolset.id, pub.slug)
                                    }
                                  >
                                    {pub.name}
                                  </button>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>
                      </div>
                    </div>
                  </div>

                  {/* Delete Button Only */}
                  <div class="flex gap-2">
                    <button
                      type="button"
                      class="px-2.5 py-1 text-xs text-[#ef4444] bg-transparent border border-[rgba(239,68,68,0.3)] rounded cursor-pointer transition-colors hover:bg-[rgba(239,68,68,0.1)]"
                      onClick={() => handleDelete(toolset)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* Create/Edit Modal */}
      <Show when={showCreateModal()}>
        <div
          class="fixed inset-0 bg-black/60 z-[1000] flex items-center justify-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div class="bg-[#1e1e1e] border border-[rgba(148,163,184,0.2)] rounded-lg w-full max-w-lg mx-4 max-h-[80vh] overflow-hidden flex flex-col">
            <div class="px-5 py-4 border-b border-[rgba(148,163,184,0.1)]">
              <h3 class="m-0 text-lg font-semibold text-foreground">
                {editingToolset() ? "Edit Toolset" : "Create Toolset"}
              </h3>
            </div>

            <div class="px-5 py-4 overflow-y-auto flex-1">
              {/* Name Input */}
              <div class="mb-4">
                <label class="block text-sm font-medium text-foreground mb-1.5">
                  Name
                </label>
                <input
                  type="text"
                  value={formName()}
                  onInput={(e) => setFormName(e.currentTarget.value)}
                  placeholder="e.g., Sales Research"
                  class="w-full px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-sm focus:outline-none focus:border-accent"
                />
              </div>

              {/* Description Input */}
              <div class="mb-4">
                <label class="block text-sm font-medium text-foreground mb-1.5">
                  Description (optional)
                </label>
                <textarea
                  value={formDescription()}
                  onInput={(e) => setFormDescription(e.currentTarget.value)}
                  placeholder="What is this toolset for?"
                  rows={2}
                  class="w-full px-3 py-2 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-sm resize-none focus:outline-none focus:border-accent"
                />
              </div>

              {/* Publisher Selection */}
              <div>
                <div class="flex items-center justify-between mb-1.5">
                  <label class="text-sm font-medium text-foreground">
                    Publishers ({formPublishers().length} selected)
                  </label>
                  <Show when={publisherSearch()}>
                    <span class="text-xs text-muted-foreground">
                      {filteredPublishers().length} of{" "}
                      {publishers()?.length ?? 0} shown
                    </span>
                  </Show>
                </div>
                {/* Search Input */}
                <div class="relative mb-2">
                  <input
                    type="text"
                    value={publisherSearch()}
                    onInput={(e) => setPublisherSearch(e.currentTarget.value)}
                    placeholder="Search publishers..."
                    class="w-full px-3 py-2 pl-8 bg-[rgba(30,30,30,0.8)] border border-[rgba(148,163,184,0.3)] rounded-md text-foreground text-sm focus:outline-none focus:border-accent"
                  />
                  <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    🔍
                  </span>
                </div>
                <Show when={publishers.loading}>
                  <div class="text-sm text-muted-foreground py-4">
                    Loading publishers...
                  </div>
                </Show>
                <Show when={!publishers.loading && publishers()?.length === 0}>
                  <div class="text-sm text-muted-foreground py-4">
                    No publishers available
                  </div>
                </Show>
                <Show
                  when={!publishers.loading && (publishers()?.length ?? 0) > 0}
                >
                  <Show when={filteredPublishers().length === 0}>
                    <div class="text-sm text-muted-foreground py-4 text-center border border-[rgba(148,163,184,0.2)] rounded-md">
                      No publishers match "{publisherSearch()}"
                    </div>
                  </Show>
                  <Show when={filteredPublishers().length > 0}>
                    <div class="max-h-[200px] overflow-y-auto border border-[rgba(148,163,184,0.2)] rounded-md">
                      <For each={filteredPublishers()}>
                        {(pub) => {
                          const isSelected = () =>
                            formPublishers().includes(pub.slug);
                          const status = getConnectionStatus(pub.slug);
                          return (
                            <label
                              class={`flex items-center gap-3 px-3 py-2.5 cursor-pointer border-b border-[rgba(148,163,184,0.1)] last:border-b-0 transition-colors ${
                                isSelected()
                                  ? "bg-[rgba(99,102,241,0.1)]"
                                  : "hover:bg-[rgba(148,163,184,0.05)]"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected()}
                                onChange={() => togglePublisher(pub.slug)}
                                class="w-4 h-4 accent-accent cursor-pointer"
                              />
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2">
                                  <span class="text-sm text-foreground">
                                    {pub.name}
                                  </span>
                                  <Show when={status === "connected"}>
                                    <span class="text-[10px] px-1.5 py-0.5 bg-[rgba(34,197,94,0.2)] text-[#22c55e] rounded">
                                      Connected
                                    </span>
                                  </Show>
                                  <Show when={status === "expired"}>
                                    <span class="text-[10px] px-1.5 py-0.5 bg-[rgba(245,158,11,0.2)] text-[#f59e0b] rounded">
                                      Expired
                                    </span>
                                  </Show>
                                </div>
                                <Show when={pub.description}>
                                  <p class="m-0 text-xs text-muted-foreground truncate">
                                    {pub.description}
                                  </p>
                                </Show>
                              </div>
                            </label>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </Show>
              </div>
            </div>

            {/* Modal Footer */}
            <div class="px-5 py-3 border-t border-[rgba(148,163,184,0.1)] flex justify-end gap-2">
              <button
                type="button"
                class="px-4 py-2 text-sm text-muted-foreground bg-transparent border border-[rgba(148,163,184,0.3)] rounded cursor-pointer transition-colors hover:bg-[rgba(148,163,184,0.1)]"
                onClick={closeModal}
              >
                Cancel
              </button>
              <button
                type="button"
                class="px-4 py-2 text-sm font-medium text-white bg-accent border-none rounded cursor-pointer transition-colors hover:bg-[#4f46e5] disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleSave}
                disabled={!formName().trim()}
              >
                {editingToolset() ? "Save Changes" : "Create Toolset"}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
};
