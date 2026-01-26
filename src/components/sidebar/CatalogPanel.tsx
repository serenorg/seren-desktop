// ABOUTME: Publisher catalog panel for browsing Seren publishers.
// ABOUTME: Provides search, filtering, and navigation to publisher details.

import {
  type Component,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import {
  catalog,
  getPricingDisplay,
  type Publisher,
  type PublisherType,
} from "@/services/catalog";

interface CatalogPanelProps {
  onSelectPublisher?: (slug: string) => void;
}

export const CatalogPanel: Component<CatalogPanelProps> = (props) => {
  const [search, setSearch] = createSignal("");
  const [selectedType, setSelectedType] = createSignal<PublisherType | null>(
    null,
  );

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
    const type = selectedType();

    return list.filter((p) => {
      // Filter by search query
      const matchesSearch =
        !query ||
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query) ||
        p.categories.some((c) => c.toLowerCase().includes(query));

      // Filter by type
      const matchesType = !type || p.publisher_type === type;

      return matchesSearch && matchesType;
    });
  };

  const publisherTypes: { id: PublisherType; label: string }[] = [
    { id: "database", label: "Databases" },
    { id: "api", label: "APIs" },
    { id: "mcp", label: "MCP" },
    { id: "compute", label: "Compute" },
  ];

  const handleSelectPublisher = (publisher: Publisher) => {
    if (props.onSelectPublisher) {
      props.onSelectPublisher(publisher.slug);
    }
  };

  return (
    <div class="flex flex-col h-full p-3 bg-card text-foreground">
      <div class="flex justify-between items-center mb-3 pb-2 border-b border-border">
        <h2 class="m-0 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Publishers
        </h2>
        <button
          class="px-2 py-1 bg-transparent text-muted-foreground border border-border rounded text-sm cursor-pointer transition-all hover:bg-muted hover:text-foreground"
          onClick={() => refetch()}
          title="Refresh publishers"
        >
          ↻
        </button>
      </div>

      <div class="mb-3">
        <input
          type="search"
          placeholder="Search publishers..."
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          class="w-full px-2.5 py-2 bg-muted border border-border rounded text-foreground text-[13px] focus:outline-none focus:border-ring placeholder:text-muted-foreground"
        />
      </div>

      <div class="flex flex-wrap gap-1.5 mb-3">
        <button
          class={`px-2.5 py-1 border-none rounded-full text-[11px] cursor-pointer transition-all ${
            !selectedType()
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
          }`}
          onClick={() => setSelectedType(null)}
        >
          All
        </button>
        <For each={publisherTypes}>
          {(type) => (
            <button
              class={`px-2.5 py-1 border-none rounded-full text-[11px] cursor-pointer transition-all ${
                selectedType() === type.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
              onClick={() => setSelectedType(type.id)}
            >
              {type.label}
            </button>
          )}
        </For>
      </div>

      <Show when={publishers.loading}>
        <div class="px-4 py-6 text-center text-muted-foreground text-[13px]">
          Loading publishers...
        </div>
      </Show>

      <Show when={publishers.error}>
        <div class="px-4 py-6 text-center text-destructive text-[13px]">
          Failed to load publishers
        </div>
      </Show>

      <div class="flex-1 overflow-y-auto flex flex-col gap-2">
        <For each={filtered()}>
          {(publisher) => (
            <div
              class="flex gap-3 p-3 bg-muted border border-border rounded-md cursor-pointer transition-all hover:bg-accent hover:border-ring"
              onClick={() => handleSelectPublisher(publisher)}
            >
              <div class="flex-shrink-0 w-10 h-10 rounded-md overflow-hidden bg-background">
                <Show
                  when={publisher.logo_url}
                  fallback={
                    <div class="w-full h-full flex items-center justify-center text-lg font-semibold text-muted-foreground">
                      {publisher.name.charAt(0).toUpperCase()}
                    </div>
                  }
                >
                  {(logoUrl) => (
                    <img
                      src={logoUrl()}
                      alt={publisher.name}
                      class="w-full h-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  )}
                </Show>
              </div>
              <div class="flex-1 min-w-0 flex flex-col gap-1">
                <div class="flex items-center gap-1.5">
                  <h3 class="m-0 text-[13px] font-semibold whitespace-nowrap overflow-hidden text-ellipsis">
                    {publisher.name}
                  </h3>
                  <Show when={publisher.is_verified}>
                    <span
                      class="text-green-500 text-xs"
                      title="Verified publisher"
                    >
                      ✓
                    </span>
                  </Show>
                </div>
                <p class="m-0 text-xs text-muted-foreground leading-snug line-clamp-2">
                  {publisher.description}
                </p>
                <div class="flex items-center gap-2 mt-1">
                  <span class="px-1.5 py-0.5 bg-background rounded text-[10px] text-muted-foreground uppercase">
                    {publisher.publisher_type}
                  </span>
                  <span class="text-[11px] text-green-500">
                    {getPricingDisplay(publisher)}
                  </span>
                </div>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={!publishers.loading && filtered().length === 0}>
        <div class="px-4 py-6 text-center text-muted-foreground text-[13px]">
          <Show
            when={search() || selectedType()}
            fallback="No publishers available"
          >
            No publishers match your search
          </Show>
        </div>
      </Show>
    </div>
  );
};
