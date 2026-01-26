// ABOUTME: Publisher catalog panel for browsing available API and database publishers.
// ABOUTME: Shows searchable list of publishers with pricing, stats, and categories.

import {
  type Component,
  createEffect,
  createSignal,
  For,
  Show,
} from "solid-js";
import { SignIn } from "@/components/auth/SignIn";
import {
  catalog,
  formatNumber,
  getPricingDisplay,
  type Publisher,
} from "@/services/catalog";
import { authStore, checkAuth } from "@/stores/auth.store";

interface CatalogPanelProps {
  onSignInClick?: () => void;
}

export const CatalogPanel: Component<CatalogPanelProps> = (_props) => {
  const [publishers, setPublishers] = createSignal<Publisher[]>([]);
  const [filteredPublishers, setFilteredPublishers] = createSignal<Publisher[]>(
    [],
  );
  const [searchQuery, setSearchQuery] = createSignal("");
  const [selectedType, setSelectedType] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedPublisher, setSelectedPublisher] =
    createSignal<Publisher | null>(null);

  const publisherTypes = [
    { id: "database", label: "Databases", icon: "🗄️" },
    { id: "api", label: "APIs", icon: "🔌" },
    { id: "mcp", label: "MCP", icon: "🔗" },
    { id: "compute", label: "Compute", icon: "🤖" },
  ];

  // Load publishers when authenticated
  createEffect(() => {
    if (authStore.isAuthenticated) {
      loadPublishers();
    }
  });

  // Filter publishers based on search and type
  createEffect(() => {
    const query = searchQuery().toLowerCase();
    const type = selectedType();

    let filtered = publishers();

    if (type) {
      filtered = filtered.filter((p) => p.publisher_type === type);
    }

    if (query) {
      filtered = filtered.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.resource_name?.toLowerCase().includes(query) ||
          p.description.toLowerCase().includes(query) ||
          p.categories.some((c) => c.toLowerCase().includes(query)),
      );
    }

    setFilteredPublishers(filtered);
  });

  async function loadPublishers() {
    setIsLoading(true);
    setError(null);
    try {
      const data = await catalog.list();
      setPublishers(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }

  function handleTypeClick(typeId: string) {
    setSelectedType((prev) => (prev === typeId ? null : typeId));
  }

  // Get display name - prefer resource_name
  function getDisplayName(publisher: Publisher): string {
    return publisher.resource_name || publisher.name;
  }

  // Get publisher name if resource_name is different
  function getPublisherName(publisher: Publisher): string | null {
    return publisher.resource_name ? publisher.name : null;
  }

  return (
    <Show
      when={authStore.isAuthenticated}
      fallback={
        <div class="flex flex-col items-center justify-center gap-8 p-8 min-h-[60vh]">
          <div class="flex flex-col items-center gap-3 text-center">
            <span class="text-[48px]">📚</span>
            <h2 class="text-xl font-semibold text-white m-0">
              Sign in to explore the catalog
            </h2>
            <p class="text-[#94a3b8] m-0">
              Browse APIs, databases, and AI services available through Seren.
            </p>
          </div>
          <SignIn onSuccess={() => checkAuth()} />
        </div>
      }
    >
      <div class="flex flex-col h-full bg-transparent">
        <header class="p-6 pb-4 border-b border-[rgba(148,163,184,0.1)]">
          <div class="max-w-[1200px] mx-auto">
            <h1 class="text-2xl font-semibold text-white m-0">
              Publisher Catalog
            </h1>
            <p class="text-[14px] text-[#94a3b8] mt-1 m-0">
              Discover APIs, databases, and AI services to power your workflows.
            </p>
          </div>
        </header>

        <div class="flex items-center gap-4 p-4 px-6 border-b border-[rgba(148,163,184,0.1)] flex-wrap">
          <div class="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="Search publishers..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              class="w-full px-4 py-2.5 bg-[rgba(15,23,42,0.6)] border border-[rgba(148,163,184,0.2)] rounded-lg text-[14px] text-white placeholder:text-[#64748b] outline-none transition-colors focus:border-[#6366f1]"
            />
          </div>
          <div class="flex gap-2 flex-wrap">
            <For each={publisherTypes}>
              {(type) => (
                <button
                  type="button"
                  class={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all cursor-pointer border ${
                    selectedType() === type.id
                      ? "bg-[#6366f1] border-[#6366f1] text-white"
                      : "bg-[rgba(30,41,59,0.5)] border-[rgba(148,163,184,0.15)] text-[#94a3b8] hover:bg-[rgba(30,41,59,0.8)] hover:text-white"
                  }`}
                  onClick={() => handleTypeClick(type.id)}
                >
                  <span class="text-[14px]">{type.icon}</span>
                  {type.label}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={error()}>
          <div class="m-6 p-4 bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.3)] rounded-lg flex items-center justify-between">
            <p class="text-[#f87171] m-0">{error()}</p>
            <button
              type="button"
              onClick={loadPublishers}
              class="px-3 py-1.5 bg-[rgba(239,68,68,0.2)] border-none rounded text-[#f87171] cursor-pointer hover:bg-[rgba(239,68,68,0.3)]"
            >
              Retry
            </button>
          </div>
        </Show>

        <Show when={isLoading()}>
          <div class="flex flex-col items-center justify-center gap-4 p-12">
            <div class="loading-spinner" />
            <p class="text-[#94a3b8] m-0">Loading publishers...</p>
          </div>
        </Show>

        <Show when={!isLoading() && !error()}>
          <div class="flex flex-1 overflow-hidden">
            <div class="flex-1 overflow-y-auto p-6">
              <Show
                when={filteredPublishers().length > 0}
                fallback={
                  <div class="flex flex-col items-center justify-center gap-3 p-12 text-center">
                    <span class="text-[48px]">🔍</span>
                    <p class="text-white text-[16px] m-0">
                      No publishers found
                    </p>
                    <p class="text-[#64748b] text-[14px] m-0">
                      {searchQuery() || selectedType()
                        ? "Try adjusting your search or filters"
                        : "Publishers will appear here once available"}
                    </p>
                  </div>
                }
              >
                <div class="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-4">
                  <For each={filteredPublishers()}>
                    {(publisher) => (
                      <article
                        class={`flex flex-col p-5 bg-[rgba(30,41,59,0.5)] border rounded-xl cursor-pointer transition-all hover:bg-[rgba(30,41,59,0.8)] hover:border-[rgba(148,163,184,0.3)] ${
                          selectedPublisher()?.id === publisher.id
                            ? "border-[#6366f1] bg-[rgba(99,102,241,0.1)]"
                            : "border-[rgba(148,163,184,0.15)]"
                        }`}
                        onClick={() => setSelectedPublisher(publisher)}
                      >
                        <div class="flex items-start gap-3 mb-3">
                          <Show
                            when={publisher.logo_url}
                            fallback={
                              <div class="w-10 h-10 rounded-lg bg-[rgba(99,102,241,0.2)] flex items-center justify-center text-[18px] font-semibold text-[#818cf8]">
                                {getDisplayName(publisher)
                                  .charAt(0)
                                  .toUpperCase()}
                              </div>
                            }
                          >
                            {(logoUrl) => (
                              <img
                                src={logoUrl()}
                                alt={publisher.name}
                                class="w-10 h-10 rounded-lg object-cover"
                              />
                            )}
                          </Show>
                          <div class="flex items-center gap-2 flex-1 min-w-0">
                            <h3 class="text-[15px] font-semibold text-white m-0 truncate">
                              {getDisplayName(publisher)}
                            </h3>
                            <Show when={publisher.is_verified}>
                              <span
                                class="flex items-center justify-center w-4 h-4 bg-[#6366f1] rounded-full text-[10px] text-white shrink-0"
                                title="Verified publisher"
                              >
                                ✓
                              </span>
                            </Show>
                          </div>
                        </div>

                        <Show when={getPublisherName(publisher)}>
                          <p class="text-[12px] text-[#64748b] -mt-2 mb-2 m-0">
                            by {getPublisherName(publisher)}
                          </p>
                        </Show>

                        <p class="text-[13px] text-[#94a3b8] leading-relaxed mb-3 m-0 line-clamp-2">
                          {publisher.description}
                        </p>

                        {/* Categories */}
                        <Show when={publisher.categories.length > 0}>
                          <div class="flex flex-wrap gap-1.5 mb-3">
                            <For each={publisher.categories.slice(0, 3)}>
                              {(cat) => (
                                <span class="px-2 py-0.5 bg-[rgba(148,163,184,0.1)] rounded text-[11px] text-[#94a3b8]">
                                  {cat}
                                </span>
                              )}
                            </For>
                            <Show when={publisher.categories.length > 3}>
                              <span class="px-2 py-0.5 text-[11px] text-[#64748b]">
                                +{publisher.categories.length - 3}
                              </span>
                            </Show>
                          </div>
                        </Show>

                        {/* Footer with stats and pricing */}
                        <div class="flex items-center justify-between mt-auto pt-3 border-t border-[rgba(148,163,184,0.1)]">
                          <div class="flex items-center gap-3">
                            <span
                              class="flex items-center gap-1 text-[12px] text-[#64748b]"
                              title="Total transactions"
                            >
                              <span>📊</span>
                              {formatNumber(publisher.total_transactions)} txns
                            </span>
                            <span
                              class="flex items-center gap-1 text-[12px] text-[#64748b]"
                              title="Agents served"
                            >
                              <span>🤖</span>
                              {formatNumber(publisher.unique_agents_served)}{" "}
                              agents
                            </span>
                          </div>
                          <span class="text-[13px] font-medium text-[#22c55e]">
                            {getPricingDisplay(publisher)}
                          </span>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <Show when={selectedPublisher()}>
              {(publisher) => (
                <aside class="w-[360px] border-l border-[rgba(148,163,184,0.1)] bg-[rgba(15,23,42,0.5)] flex flex-col overflow-hidden">
                  <div class="flex items-center justify-between p-4 border-b border-[rgba(148,163,184,0.1)]">
                    <h2 class="text-[16px] font-semibold text-white m-0">
                      {getDisplayName(publisher())}
                    </h2>
                    <button
                      type="button"
                      class="w-7 h-7 flex items-center justify-center bg-transparent border-none rounded text-[20px] text-[#64748b] cursor-pointer hover:bg-[rgba(148,163,184,0.1)] hover:text-white"
                      onClick={() => setSelectedPublisher(null)}
                    >
                      ×
                    </button>
                  </div>
                  <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
                    <Show when={publisher().logo_url}>
                      {(logoUrl) => (
                        <img
                          src={logoUrl()}
                          alt={publisher().name}
                          class="w-16 h-16 rounded-xl object-cover"
                        />
                      )}
                    </Show>

                    <Show when={getPublisherName(publisher())}>
                      <p class="text-[13px] text-[#64748b] -mt-3 m-0">
                        by {getPublisherName(publisher())}
                      </p>
                    </Show>

                    <p class="text-[14px] text-[#94a3b8] leading-relaxed m-0">
                      {publisher().description}
                    </p>

                    {/* Stats section */}
                    <div class="flex flex-col gap-2">
                      <h4 class="text-[12px] font-semibold text-[#64748b] uppercase tracking-wide m-0">
                        Usage
                      </h4>
                      <div class="grid grid-cols-2 gap-3">
                        <div class="p-3 bg-[rgba(30,41,59,0.5)] rounded-lg text-center">
                          <span class="block text-[18px] font-semibold text-white tabular-nums">
                            {formatNumber(publisher().total_transactions ?? 0)}
                          </span>
                          <span class="text-[11px] text-[#64748b]">
                            Transactions
                          </span>
                        </div>
                        <div class="p-3 bg-[rgba(30,41,59,0.5)] rounded-lg text-center">
                          <span class="block text-[18px] font-semibold text-white tabular-nums">
                            {formatNumber(
                              publisher().unique_agents_served ?? 0,
                            )}
                          </span>
                          <span class="text-[11px] text-[#64748b]">Agents</span>
                        </div>
                      </div>
                    </div>

                    {/* Pricing section */}
                    <div class="flex flex-col gap-2">
                      <h4 class="text-[12px] font-semibold text-[#64748b] uppercase tracking-wide m-0">
                        Pricing
                      </h4>
                      <div class="flex flex-col gap-2">
                        <span class="inline-flex px-3 py-1.5 bg-[rgba(34,197,94,0.1)] rounded-lg text-[14px] font-medium text-[#22c55e] w-fit">
                          {getPricingDisplay(publisher())}
                        </span>
                        <Show when={publisher().billing_model}>
                          <p class="text-[13px] text-[#64748b] m-0">
                            Model:{" "}
                            {publisher().billing_model === "prepaid_credits"
                              ? "Prepaid Credits"
                              : "Pay per Request"}
                          </p>
                        </Show>
                      </div>
                    </div>

                    {/* Categories section */}
                    <Show when={(publisher().categories?.length ?? 0) > 0}>
                      <div class="flex flex-col gap-2">
                        <h4 class="text-[12px] font-semibold text-[#64748b] uppercase tracking-wide m-0">
                          Categories
                        </h4>
                        <div class="flex flex-wrap gap-1.5">
                          <For each={publisher().categories}>
                            {(cat) => (
                              <span class="px-2 py-0.5 bg-[rgba(148,163,184,0.1)] rounded text-[12px] text-[#94a3b8]">
                                {cat}
                              </span>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    {/* Integration section */}
                    <div class="flex flex-col gap-2">
                      <h4 class="text-[12px] font-semibold text-[#64748b] uppercase tracking-wide m-0">
                        Integration
                      </h4>
                      <p class="text-[13px] text-[#94a3b8] m-0">
                        Slug:{" "}
                        <code class="px-1.5 py-0.5 bg-[rgba(15,23,42,0.8)] rounded text-[12px] text-[#818cf8] font-mono">
                          {publisher().slug}
                        </code>
                      </p>
                      <p class="text-[13px] text-[#94a3b8] m-0">
                        Type:{" "}
                        <code class="px-1.5 py-0.5 bg-[rgba(15,23,42,0.8)] rounded text-[12px] text-[#818cf8] font-mono">
                          {publisher().publisher_type}
                        </code>
                      </p>
                    </div>
                  </div>
                </aside>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default CatalogPanel;
