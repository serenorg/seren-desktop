// ABOUTME: Publisher catalog panel for browsing available API and database publishers.
// ABOUTME: Shows searchable list of publishers with pricing, stats, and categories.

import { createSignal, createEffect, For, Show, type Component } from "solid-js";
import { catalog, getPricingDisplay, formatNumber, type Publisher } from "@/services/catalog";
import { authStore, checkAuth } from "@/stores/auth.store";
import { SignIn } from "@/components/auth/SignIn";
import "./CatalogPanel.css";

interface CatalogPanelProps {
  onSignInClick?: () => void;
}

export const CatalogPanel: Component<CatalogPanelProps> = (_props) => {
  const [publishers, setPublishers] = createSignal<Publisher[]>([]);
  const [filteredPublishers, setFilteredPublishers] = createSignal<Publisher[]>([]);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [selectedType, setSelectedType] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedPublisher, setSelectedPublisher] = createSignal<Publisher | null>(null);

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
      filtered = filtered.filter(p => p.publisher_type === type);
    }

    if (query) {
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(query) ||
        (p.resource_name?.toLowerCase().includes(query)) ||
        p.description.toLowerCase().includes(query) ||
        p.categories.some(c => c.toLowerCase().includes(query))
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
    setSelectedType(prev => prev === typeId ? null : typeId);
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
        <div class="catalog-signin-prompt">
          <div class="signin-prompt-header">
            <span class="signin-prompt-icon">📚</span>
            <h2>Sign in to explore the catalog</h2>
            <p>Browse APIs, databases, and AI services available through Seren.</p>
          </div>
          <SignIn onSuccess={() => checkAuth()} />
        </div>
      }
    >
      <div class="catalog-panel">
        <header class="catalog-header">
          <div class="catalog-header-content">
            <h1>Publisher Catalog</h1>
            <p class="catalog-subtitle">
              Discover APIs, databases, and AI services to power your workflows.
            </p>
          </div>
        </header>

        <div class="catalog-toolbar">
          <div class="catalog-search">
            <input
              type="text"
              placeholder="Search publishers..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
            />
          </div>
          <div class="catalog-categories">
            <For each={publisherTypes}>
              {(type) => (
                <button
                  type="button"
                  class={`category-btn ${selectedType() === type.id ? "active" : ""}`}
                  onClick={() => handleTypeClick(type.id)}
                >
                  <span class="category-icon">{type.icon}</span>
                  {type.label}
                </button>
              )}
            </For>
          </div>
        </div>

        <Show when={error()}>
          <div class="catalog-error">
            <p>{error()}</p>
            <button type="button" onClick={loadPublishers}>Retry</button>
          </div>
        </Show>

        <Show when={isLoading()}>
          <div class="catalog-loading">
            <div class="loading-spinner" />
            <p>Loading publishers...</p>
          </div>
        </Show>

        <Show when={!isLoading() && !error()}>
          <div class="catalog-content">
            <div class="catalog-grid">
              <Show
                when={filteredPublishers().length > 0}
                fallback={
                  <div class="catalog-empty">
                    <span class="empty-icon">🔍</span>
                    <p>No publishers found</p>
                    <p class="empty-hint">
                      {searchQuery() || selectedType()
                        ? "Try adjusting your search or filters"
                        : "Publishers will appear here once available"}
                    </p>
                  </div>
                }
              >
                <For each={filteredPublishers()}>
                  {(publisher) => (
                    <article
                      class={`publisher-card ${selectedPublisher()?.id === publisher.id ? "selected" : ""}`}
                      onClick={() => setSelectedPublisher(publisher)}
                    >
                      <div class="publisher-header">
                        <Show
                          when={publisher.logo_url}
                          fallback={
                            <div class="publisher-logo-placeholder">
                              {getDisplayName(publisher).charAt(0).toUpperCase()}
                            </div>
                          }
                        >
                          <img
                            src={publisher.logo_url!}
                            alt={publisher.name}
                            class="publisher-logo"
                          />
                        </Show>
                        <div class="publisher-title">
                          <h3>{getDisplayName(publisher)}</h3>
                          <Show when={publisher.is_verified}>
                            <span class="verified-badge" title="Verified publisher">✓</span>
                          </Show>
                        </div>
                      </div>

                      <Show when={getPublisherName(publisher)}>
                        <p class="publisher-byline">by {getPublisherName(publisher)}</p>
                      </Show>

                      <p class="publisher-description">{publisher.description}</p>

                      {/* Categories */}
                      <Show when={publisher.categories.length > 0}>
                        <div class="publisher-categories">
                          <For each={publisher.categories.slice(0, 3)}>
                            {(cat) => <span class="category-tag">{cat}</span>}
                          </For>
                          <Show when={publisher.categories.length > 3}>
                            <span class="category-more">
                              +{publisher.categories.length - 3}
                            </span>
                          </Show>
                        </div>
                      </Show>

                      {/* Footer with stats and pricing */}
                      <div class="publisher-footer">
                        <div class="publisher-stats">
                          <span class="stat-item" title="Total transactions">
                            <span class="stat-icon">📊</span>
                            {formatNumber(publisher.total_transactions)} txns
                          </span>
                          <span class="stat-item" title="Agents served">
                            <span class="stat-icon">🤖</span>
                            {formatNumber(publisher.unique_agents_served)} agents
                          </span>
                        </div>
                        <span class="publisher-price">{getPricingDisplay(publisher)}</span>
                      </div>
                    </article>
                  )}
                </For>
              </Show>
            </div>

            <Show when={selectedPublisher()}>
              <aside class="publisher-detail">
                <div class="detail-header">
                  <h2>{getDisplayName(selectedPublisher()!)}</h2>
                  <button
                    type="button"
                    class="detail-close"
                    onClick={() => setSelectedPublisher(null)}
                  >
                    ×
                  </button>
                </div>
                <div class="detail-content">
                  <Show when={selectedPublisher()!.logo_url}>
                    <img
                      src={selectedPublisher()!.logo_url!}
                      alt={selectedPublisher()!.name}
                      class="detail-logo"
                    />
                  </Show>

                  <Show when={getPublisherName(selectedPublisher()!)}>
                    <p class="detail-byline">by {getPublisherName(selectedPublisher()!)}</p>
                  </Show>

                  <p class="detail-description">{selectedPublisher()!.description}</p>

                  {/* Stats section */}
                  <div class="detail-section">
                    <h4>Usage</h4>
                    <div class="detail-stats">
                      <div class="stat-card">
                        <span class="stat-value">{formatNumber(selectedPublisher()!.total_transactions)}</span>
                        <span class="stat-label">Transactions</span>
                      </div>
                      <div class="stat-card">
                        <span class="stat-value">{formatNumber(selectedPublisher()!.unique_agents_served)}</span>
                        <span class="stat-label">Agents</span>
                      </div>
                    </div>
                  </div>

                  {/* Pricing section */}
                  <div class="detail-section">
                    <h4>Pricing</h4>
                    <div class="detail-pricing">
                      <span class="pricing-badge">{getPricingDisplay(selectedPublisher()!)}</span>
                      <Show when={selectedPublisher()!.billing_model}>
                        <p class="pricing-model">
                          Model: {selectedPublisher()!.billing_model === "prepaid_credits" ? "Prepaid Credits" : "Pay per Request"}
                        </p>
                      </Show>
                    </div>
                  </div>

                  {/* Categories section */}
                  <Show when={selectedPublisher()!.categories.length > 0}>
                    <div class="detail-section">
                      <h4>Categories</h4>
                      <div class="detail-categories">
                        <For each={selectedPublisher()!.categories}>
                          {(cat) => <span class="category-tag">{cat}</span>}
                        </For>
                      </div>
                    </div>
                  </Show>

                  {/* Integration section */}
                  <div class="detail-section">
                    <h4>Integration</h4>
                    <p class="detail-slug">
                      Slug: <code>{selectedPublisher()!.slug}</code>
                    </p>
                    <p class="detail-type">
                      Type: <code>{selectedPublisher()!.publisher_type}</code>
                    </p>
                  </div>
                </div>
              </aside>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default CatalogPanel;
