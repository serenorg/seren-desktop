// ABOUTME: Publisher details view component.
// ABOUTME: Shows full publisher information including pricing and categories.

import { type Component, createResource, For, Show } from "solid-js";
import { catalog, formatPrice, getPricingDisplay } from "@/services/catalog";
import "./PublisherDetails.css";

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
    <div class="publisher-details">
      <button class="back-button" onClick={() => props.onBack()}>
        ← Back to Publishers
      </button>

      <Show when={publisher.loading}>
        <div class="publisher-details-loading">
          Loading publisher details...
        </div>
      </Show>

      <Show when={publisher.error || (!publisher.loading && !publisher())}>
        <div class="publisher-details-error">
          Failed to load publisher details.
          <button onClick={() => props.onBack()}>Go back</button>
        </div>
      </Show>

      <Show when={publisher()}>
        {(pub) => (
          <div class="publisher-details-content">
            <div class="publisher-details-header">
              <div class="publisher-details-logo">
                <Show
                  when={pub().logo_url}
                  fallback={
                    <div class="publisher-logo-placeholder">
                      {pub().name.charAt(0).toUpperCase()}
                    </div>
                  }
                >
                  <img src={pub().logo_url!} alt={pub().name} />
                </Show>
              </div>
              <div class="publisher-details-title">
                <h1>
                  {pub().name}
                  <Show when={pub().is_verified}>
                    <span class="verified-badge" title="Verified publisher">
                      ✓ Verified
                    </span>
                  </Show>
                </h1>
                <span class="publisher-slug">@{pub().slug}</span>
              </div>
            </div>

            <p class="publisher-details-description">{pub().description}</p>

            <section class="publisher-section">
              <h3>Pricing</h3>
              <div class="pricing-grid">
                <div class="pricing-item">
                  <span class="pricing-label">Price</span>
                  <span class="pricing-value">{getPricingDisplay(pub())}</span>
                </div>
                <Show when={pub().price_per_call !== null}>
                  <div class="pricing-item">
                    <span class="pricing-label">Per Call</span>
                    <span class="pricing-value">
                      {formatPrice(pub().price_per_call)}
                    </span>
                  </div>
                </Show>
                <Show when={pub().base_price_per_1000_rows !== null}>
                  <div class="pricing-item">
                    <span class="pricing-label">Per 1K Rows</span>
                    <span class="pricing-value">
                      {formatPrice(pub().base_price_per_1000_rows)}
                    </span>
                  </div>
                </Show>
                <Show when={pub().price_per_execution !== null}>
                  <div class="pricing-item">
                    <span class="pricing-label">Per Execution</span>
                    <span class="pricing-value">
                      {formatPrice(pub().price_per_execution)}
                    </span>
                  </div>
                </Show>
              </div>
            </section>

            <Show when={pub().categories.length > 0}>
              <section class="publisher-section">
                <h3>Categories</h3>
                <ul class="capabilities-list">
                  <For each={pub().categories}>
                    {(category) => <li>{category}</li>}
                  </For>
                </ul>
              </section>
            </Show>

            <section class="publisher-section">
              <h3>Details</h3>
              <div class="details-grid">
                <div class="details-item">
                  <span class="details-label">Type</span>
                  <span class="details-value">{pub().publisher_type}</span>
                </div>
                <div class="details-item">
                  <span class="details-label">Status</span>
                  <span
                    class={`details-value status-${pub().is_active ? "active" : "inactive"}`}
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
