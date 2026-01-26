// ABOUTME: Publisher details view component.
// ABOUTME: Shows full publisher information including pricing and categories.

import { type Component, createResource, For, Show } from "solid-js";
import { catalog, formatPrice, getPricingDisplay } from "@/services/catalog";

interface PublisherDetailsProps {
  slug: string;
  onBack: () => void;
}

export const PublisherDetails: Component<PublisherDetailsProps> = (props) => {
  const [publisher] = createResource(
    () => props.slug,
    async (slug) => {
      try {
        return await catalog.get(slug);
      } catch {
        return null;
      }
    },
  );

  return (
    <div class="flex flex-col h-full p-3 bg-card text-foreground overflow-y-auto">
      <button
        class="self-start px-3 py-1.5 mb-4 bg-transparent text-primary border-none rounded text-[13px] cursor-pointer transition-colors hover:bg-muted"
        onClick={() => props.onBack()}
      >
        ← Back to Publishers
      </button>

      <Show when={publisher.loading}>
        <div class="px-4 py-6 text-center text-muted-foreground text-[13px]">
          Loading publisher details...
        </div>
      </Show>

      <Show when={publisher.error || (!publisher.loading && !publisher())}>
        <div class="px-4 py-6 text-center text-destructive text-[13px]">
          Failed to load publisher details.
          <button
            class="mt-3 px-3 py-1.5 bg-primary text-primary-foreground border-none rounded cursor-pointer"
            onClick={() => props.onBack()}
          >
            Go back
          </button>
        </div>
      </Show>

      <Show when={publisher()}>
        {(pub) => (
          <div class="flex flex-col gap-5">
            <div class="flex gap-4 items-start">
              <div class="flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-muted">
                <Show
                  when={pub().logo_url}
                  fallback={
                    <div class="w-full h-full flex items-center justify-center text-[28px] font-semibold text-muted-foreground">
                      {pub().name.charAt(0).toUpperCase()}
                    </div>
                  }
                >
                  {(logoUrl) => (
                    <img
                      src={logoUrl()}
                      alt={pub().name}
                      class="w-full h-full object-cover"
                    />
                  )}
                </Show>
              </div>
              <div class="flex-1">
                <h1 class="m-0 mb-1 text-xl font-semibold flex items-center gap-2">
                  {pub().name}
                  <Show when={pub().is_verified}>
                    <span
                      class="text-xs font-medium text-green-500 px-1.5 py-0.5 bg-green-500/10 rounded"
                      title="Verified publisher"
                    >
                      ✓ Verified
                    </span>
                  </Show>
                </h1>
                <span class="text-[13px] text-muted-foreground">
                  @{pub().slug}
                </span>
              </div>
            </div>

            <p class="m-0 text-sm leading-relaxed text-foreground">
              {pub().description}
            </p>

            <section class="pt-4 border-t border-border">
              <h3 class="m-0 mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Pricing
              </h3>
              <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1 p-2.5 bg-muted rounded-md">
                  <span class="text-[11px] text-muted-foreground">Price</span>
                  <span class="text-base font-semibold text-green-500">
                    {getPricingDisplay(pub())}
                  </span>
                </div>
                <Show when={pub().price_per_call !== null}>
                  <div class="flex flex-col gap-1 p-2.5 bg-muted rounded-md">
                    <span class="text-[11px] text-muted-foreground">
                      Per Call
                    </span>
                    <span class="text-base font-semibold text-green-500">
                      {formatPrice(pub().price_per_call)}
                    </span>
                  </div>
                </Show>
                <Show when={pub().base_price_per_1000_rows !== null}>
                  <div class="flex flex-col gap-1 p-2.5 bg-muted rounded-md">
                    <span class="text-[11px] text-muted-foreground">
                      Per 1K Rows
                    </span>
                    <span class="text-base font-semibold text-green-500">
                      {formatPrice(pub().base_price_per_1000_rows)}
                    </span>
                  </div>
                </Show>
                <Show when={pub().price_per_execution !== null}>
                  <div class="flex flex-col gap-1 p-2.5 bg-muted rounded-md">
                    <span class="text-[11px] text-muted-foreground">
                      Per Execution
                    </span>
                    <span class="text-base font-semibold text-green-500">
                      {formatPrice(pub().price_per_execution)}
                    </span>
                  </div>
                </Show>
              </div>
            </section>

            <Show when={pub().categories.length > 0}>
              <section class="pt-4 border-t border-border">
                <h3 class="m-0 mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Categories
                </h3>
                <ul class="m-0 p-0 list-none flex flex-wrap gap-2">
                  <For each={pub().categories}>
                    {(category) => (
                      <li class="px-2.5 py-1 bg-muted border border-border rounded text-xs">
                        {category}
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>

            <section class="pt-4 border-t border-border">
              <h3 class="m-0 mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Details
              </h3>
              <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Type</span>
                  <span class="text-sm">{pub().publisher_type}</span>
                </div>
                <div class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Status</span>
                  <span
                    class={`text-sm ${pub().is_active ? "text-green-500" : "text-destructive"}`}
                  >
                    {pub().is_active ? "Active" : "Inactive"}
                  </span>
                </div>
              </div>
            </section>
          </div>
        )}
      </Show>
    </div>
  );
};
