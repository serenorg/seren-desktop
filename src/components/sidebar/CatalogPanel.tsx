// ABOUTME: Publisher catalog panel for browsing Seren publishers.
// ABOUTME: Provides search, filtering, and navigation to publisher details.

import { Component, For, createSignal, createResource, Show } from "solid-js";
import { catalog, Publisher } from "@/services/catalog";
import "./CatalogPanel.css";

interface CatalogPanelProps {
  onSelectPublisher?: (slug: string) => void;
}

export const CatalogPanel: Component<CatalogPanelProps> = (props) => {
  const [search, setSearch] = createSignal("");
  const [selectedCategory, setSelectedCategory] = createSignal<string | null>(null);

  const [publishers, { refetch }] = createResource(async () => {
    try {
      return await catalog.list();
    } catch {
      return [];
    }
  });

  const filtered = () => {
    const list = publishers() || [];
    const query = search().toLowerCase().trim();
    const category = selectedCategory();

    return list.filter((p) => {
      // Filter by search query
      const matchesSearch =
        !query ||
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query) ||
        p.capabilities.some((c) => c.toLowerCase().includes(query));

      // Filter by category
      const matchesCategory = !category || p.category === category;

      return matchesSearch && matchesCategory;
    });
  };

  const categories = () => {
    const list = publishers() || [];
    const cats = new Set(list.map((p) => p.category));
    return Array.from(cats).sort();
  };

  const handleSelectPublisher = (publisher: Publisher) => {
    if (props.onSelectPublisher) {
      props.onSelectPublisher(publisher.slug);
    }
  };

  return (
    <div class="catalog-panel">
      <div class="catalog-header">
        <h2>Publishers</h2>
        <button
          class="catalog-refresh-btn"
          onClick={() => refetch()}
          title="Refresh publishers"
        >
          ↻
        </button>
      </div>

      <div class="catalog-search">
        <input
          type="search"
          placeholder="Search publishers..."
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
        />
      </div>

      <div class="catalog-categories">
        <button
          class={`category-btn ${!selectedCategory() ? "active" : ""}`}
          onClick={() => setSelectedCategory(null)}
        >
          All
        </button>
        <For each={categories()}>
          {(category) => (
            <button
              class={`category-btn ${selectedCategory() === category ? "active" : ""}`}
              onClick={() => setSelectedCategory(category)}
            >
              {category}
            </button>
          )}
        </For>
      </div>

      <Show when={publishers.loading}>
        <div class="catalog-loading">Loading publishers...</div>
      </Show>

      <Show when={publishers.error}>
        <div class="catalog-error">Failed to load publishers</div>
      </Show>

      <div class="catalog-list">
        <For each={filtered()}>
          {(publisher) => (
            <div
              class="publisher-card"
              onClick={() => handleSelectPublisher(publisher)}
            >
              <div class="publisher-logo">
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
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                </Show>
              </div>
              <div class="publisher-info">
                <div class="publisher-header">
                  <h3 class="publisher-name">{publisher.name}</h3>
                  <Show when={publisher.is_verified}>
                    <span class="verified-badge" title="Verified publisher">
                      ✓
                    </span>
                  </Show>
                </div>
                <p class="publisher-description">{publisher.description}</p>
                <div class="publisher-meta">
                  <span class="publisher-category">{publisher.category}</span>
                  <span class="publisher-price">
                    ${publisher.pricing.price_per_call}/call
                  </span>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={!publishers.loading && filtered().length === 0}>
        <div class="catalog-empty">
          <Show
            when={search() || selectedCategory()}
            fallback="No publishers available"
          >
            No publishers match your search
          </Show>
        </div>
      </Show>
    </div>
  );
};
