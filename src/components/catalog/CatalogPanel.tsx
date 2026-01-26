// ABOUTME: Publisher catalog panel for browsing available API and database publishers.
// ABOUTME: Shows searchable list of publishers with pricing and capabilities.

import { createSignal, createEffect, For, Show, type Component } from "solid-js";
import { catalog, type Publisher } from "@/services/catalog";
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
  const [selectedCategory, setSelectedCategory] = createSignal<string | null>(null);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [selectedPublisher, setSelectedPublisher] = createSignal<Publisher | null>(null);

  const categories = [
    { id: "database", label: "Databases", icon: "🗄️" },
    { id: "integration", label: "APIs", icon: "🔌" },
    { id: "compute", label: "AI & Compute", icon: "🤖" },
  ];

  // Load publishers when authenticated
  createEffect(() => {
    if (authStore.isAuthenticated) {
      loadPublishers();
    }
  });

  // Filter publishers based on search and category
  createEffect(() => {
    const query = searchQuery().toLowerCase();
    const category = selectedCategory();

    let filtered = publishers();

    if (category) {
      filtered = filtered.filter(p => p.category === category);
    }

    if (query) {
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query) ||
        p.capabilities.some(c => c.toLowerCase().includes(query))
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

  function formatPrice(pricing: Publisher["pricing"]): string {
    if (pricing.price_per_call) {
      const price = parseFloat(pricing.price_per_call);
      if (price === 0) return "Free";
      if (price < 0.01) return `$${(price * 1000).toFixed(2)}/1K calls`;
      return `$${price.toFixed(4)}/call`;
    }
    if (pricing.price_per_query) {
      const price = parseFloat(pricing.price_per_query);
      if (price === 0) return "Free";
      return `$${price.toFixed(4)}/query`;
    }
    return "Contact for pricing";
  }

  function handleCategoryClick(categoryId: string) {
    setSelectedCategory(prev => prev === categoryId ? null : categoryId);
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
            <For each={categories}>
              {(cat) => (
                <button
                  type="button"
                  class={`category-btn ${selectedCategory() === cat.id ? "active" : ""}`}
                  onClick={() => handleCategoryClick(cat.id)}
                >
                  <span class="category-icon">{cat.icon}</span>
                  {cat.label}
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
                      {searchQuery() || selectedCategory()
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
                              {publisher.name.charAt(0).toUpperCase()}
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
                          <h3>{publisher.name}</h3>
                          <Show when={publisher.is_verified}>
                            <span class="verified-badge" title="Verified publisher">✓</span>
                          </Show>
                        </div>
                      </div>
                      <p class="publisher-description">{publisher.description}</p>
                      <div class="publisher-meta">
                        <span class="publisher-category">{publisher.category}</span>
                        <span class="publisher-price">{formatPrice(publisher.pricing)}</span>
                      </div>
                      <Show when={publisher.capabilities.length > 0}>
                        <div class="publisher-capabilities">
                          <For each={publisher.capabilities.slice(0, 3)}>
                            {(cap) => <span class="capability-tag">{cap}</span>}
                          </For>
                          <Show when={publisher.capabilities.length > 3}>
                            <span class="capability-more">
                              +{publisher.capabilities.length - 3} more
                            </span>
                          </Show>
                        </div>
                      </Show>
                    </article>
                  )}
                </For>
              </Show>
            </div>

            <Show when={selectedPublisher()}>
              <aside class="publisher-detail">
                <div class="detail-header">
                  <h2>{selectedPublisher()!.name}</h2>
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
                  <p class="detail-description">{selectedPublisher()!.description}</p>

                  <div class="detail-section">
                    <h4>Pricing</h4>
                    <div class="detail-pricing">
                      <div class="pricing-item">
                        <span class="pricing-label">Per Call</span>
                        <span class="pricing-value">
                          {formatPrice(selectedPublisher()!.pricing)}
                        </span>
                      </div>
                      <Show when={selectedPublisher()!.pricing.min_charge}>
                        <div class="pricing-item">
                          <span class="pricing-label">Min Charge</span>
                          <span class="pricing-value">
                            ${selectedPublisher()!.pricing.min_charge}
                          </span>
                        </div>
                      </Show>
                      <Show when={selectedPublisher()!.pricing.max_charge}>
                        <div class="pricing-item">
                          <span class="pricing-label">Max Charge</span>
                          <span class="pricing-value">
                            ${selectedPublisher()!.pricing.max_charge}
                          </span>
                        </div>
                      </Show>
                    </div>
                  </div>

                  <Show when={selectedPublisher()!.capabilities.length > 0}>
                    <div class="detail-section">
                      <h4>Capabilities</h4>
                      <div class="detail-capabilities">
                        <For each={selectedPublisher()!.capabilities}>
                          {(cap) => <span class="capability-tag">{cap}</span>}
                        </For>
                      </div>
                    </div>
                  </Show>

                  <div class="detail-section">
                    <h4>Integration</h4>
                    <p class="detail-slug">
                      Slug: <code>{selectedPublisher()!.slug}</code>
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
