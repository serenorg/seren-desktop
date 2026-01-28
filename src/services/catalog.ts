// ABOUTME: Publisher catalog service for fetching publisher data from Seren API.
// ABOUTME: Uses generated hey-api SDK for type-safe API calls.

import {
  getStorePublisher,
  listStorePublishers,
  type PublisherResponse,
  suggestPublishers,
} from "@/api";
import { apiBase } from "@/lib/config";

/**
 * Publisher type (database, api, mcp, compute).
 */
export type PublisherType = "database" | "api" | "mcp" | "compute";

/**
 * Billing model (x402_per_request, prepaid_credits).
 */
export type BillingModel = "x402_per_request" | "prepaid_credits";

/**
 * Publisher data structure (normalized for UI).
 */
export interface Publisher {
  id: string;
  slug: string;
  name: string;
  resource_name: string | null;
  resource_description: string | null;
  description: string;
  logo_url: string | null;
  publisher_type: PublisherType;
  billing_model: BillingModel | null;
  // Pricing fields
  price_per_call: number | null;
  base_price_per_1000_rows: number | null;
  price_per_execution: number | null;
  // Stats
  total_transactions: number;
  unique_agents_served: number;
  // Metadata
  categories: string[];
  is_verified: boolean;
  is_active: boolean;
}

// Use the generated PublisherResponse type as the raw API structure
type RawPublisher = PublisherResponse;

/**
 * Parse a numeric value that could be string or number.
 */
function parseNumericPrice(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "string" ? parseFloat(value) : value;
  return Number.isNaN(num) ? null : num;
}

/**
 * Transform raw API publisher to normalized UI publisher.
 */
function transformPublisher(raw: RawPublisher): Publisher {
  // Handle logo_url - convert relative paths to absolute URLs
  let logoUrl = raw.logo_url;
  if (logoUrl?.startsWith("/")) {
    logoUrl = `${apiBase}${logoUrl}`;
  }

  // Determine publisher type from publisher_category
  let publisherType: PublisherType = "api";
  if (raw.publisher_category === "database") {
    publisherType = "database";
  } else if (raw.integration_type === "mcp") {
    publisherType = "mcp";
  } else if (raw.publisher_category === "compute") {
    publisherType = "compute";
  }

  // Determine billing model
  let billingModel: BillingModel | null = null;
  if (
    raw.billing_model === "x402_per_request" ||
    raw.billing_model === "prepaid_credits"
  ) {
    billingModel = raw.billing_model;
  }

  // Extract pricing from pricing array
  let pricePerCall: number | null = null;
  let basePricePer1000Rows: number | null = null;
  let pricePerExecution: number | null = null;

  if (Array.isArray(raw.pricing) && raw.pricing.length > 0) {
    const pricing = raw.pricing[0];
    pricePerCall = parseNumericPrice(pricing.price_per_call);
    basePricePer1000Rows = parseNumericPrice(pricing.base_price_per_1000_rows);
    pricePerExecution = parseNumericPrice(pricing.price_per_execution);
  }

  // Handle categories - use categories, capabilities, or use_cases
  let categories: string[] = [];
  if (raw.categories && raw.categories.length > 0) {
    categories = raw.categories;
  } else if (raw.capabilities && raw.capabilities.length > 0) {
    categories = raw.capabilities;
  } else if (raw.use_cases && raw.use_cases.length > 0) {
    categories = raw.use_cases;
  }

  // Get description - prefer resource_description, fallback to description
  const description = raw.resource_description || raw.description || "";

  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    resource_name: raw.resource_name || null,
    resource_description: raw.resource_description || null,
    description,
    logo_url: logoUrl || null,
    publisher_type: publisherType,
    billing_model: billingModel,
    price_per_call: pricePerCall,
    base_price_per_1000_rows: basePricePer1000Rows,
    price_per_execution: pricePerExecution,
    total_transactions: raw.total_queries || 0,
    unique_agents_served: raw.unique_agents_served || 0,
    categories,
    is_verified: raw.is_verified ?? false,
    is_active: raw.is_active ?? true,
  };
}

/**
 * Format a price for display.
 */
export function formatPrice(price: number | null): string | null {
  if (price === null) return null;
  if (price < 0.0001) return `$${price.toFixed(6)}`;
  if (price < 0.01) return `$${price.toFixed(5)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

/**
 * Get pricing display string based on publisher type and billing model.
 */
export function getPricingDisplay(publisher: Publisher): string {
  // Handle prepaid_credits billing model
  if (publisher.billing_model === "prepaid_credits") {
    if (
      publisher.price_per_execution !== null &&
      publisher.price_per_execution > 0
    ) {
      const formatted = formatPrice(publisher.price_per_execution);
      return `${formatted}/execution`;
    }
    return "Pay per execution";
  }

  // Handle database pricing
  if (publisher.publisher_type === "database") {
    if (publisher.base_price_per_1000_rows !== null) {
      const formatted = formatPrice(publisher.base_price_per_1000_rows);
      return `${formatted}/1K rows`;
    }
  }

  // Handle API pricing
  if (publisher.price_per_call !== null) {
    if (publisher.price_per_call === 0) return "Free";
    const formatted = formatPrice(publisher.price_per_call);
    return `${formatted}/call`;
  }

  return "Contact for pricing";
}

/**
 * Format a number for display (e.g., 1500 -> "1.5K", 1500000 -> "1.5M").
 */
export function formatNumber(num: number): string {
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1)}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1)}K`;
  }
  return num.toString();
}

/**
 * Publisher catalog service for Seren API operations.
 * Uses generated SDK with full type safety.
 */
export const catalog = {
  /**
   * List all active publishers.
   */
  async list(): Promise<Publisher[]> {
    console.log("[Catalog] Fetching publishers");
    const { data, error } = await listStorePublishers({
      query: { limit: 100 },
      throwOnError: false,
    });
    if (error) {
      console.error("[Catalog] Error fetching publishers:", error);
      throw new Error("Failed to list publishers");
    }
    const rawPublishers = data?.data || [];
    console.log("[Catalog] Found", rawPublishers.length, "publishers");
    return rawPublishers.map(transformPublisher);
  },

  /**
   * Get a single publisher by slug.
   */
  async get(slug: string): Promise<Publisher> {
    const { data, error } = await getStorePublisher({
      path: { slug },
      throwOnError: false,
    });
    if (error || !data?.data) {
      throw new Error("Failed to get publisher");
    }
    return transformPublisher(data.data);
  },

  /**
   * Search publishers by query.
   * Returns matching publishers based on name, description, or categories.
   */
  async search(query: string): Promise<Publisher[]> {
    if (!query.trim()) {
      return this.list();
    }
    const { data, error } = await listStorePublishers({
      query: { search: query },
      throwOnError: false,
    });
    if (error) {
      throw new Error("Failed to search publishers");
    }
    const rawPublishers = data?.data || [];
    return rawPublishers.map(transformPublisher);
  },

  /**
   * Get publisher suggestions for a task.
   * Returns publishers that match the given task description.
   */
  async suggest(query: string): Promise<Publisher[]> {
    if (!query.trim()) {
      return [];
    }
    const { data } = await suggestPublishers({
      query: { query },
      throwOnError: false,
    });
    // Suggestions are optional, return empty on error
    if (!data?.data?.publishers) {
      return [];
    }
    // suggestPublishers returns PublisherSuggestion[], which has a subset of fields
    // We need to fetch full publisher details or return partial data
    // For now, map what we can from the suggestion
    return data.data.publishers.map((suggestion) => ({
      id: "",
      slug: suggestion.slug,
      name: suggestion.name,
      resource_name: null,
      resource_description: null,
      description: suggestion.description || "",
      logo_url: null, // PublisherSuggestion doesn't include logo_url
      publisher_type: "api" as PublisherType,
      billing_model: null,
      price_per_call: null,
      base_price_per_1000_rows: suggestion.pricing?.base_price_per_1000_rows
        ? parseNumericPrice(suggestion.pricing.base_price_per_1000_rows)
        : null,
      price_per_execution: null,
      total_transactions: 0,
      unique_agents_served: 0,
      categories: suggestion.capabilities || [],
      is_verified: false,
      is_active: true,
    }));
  },

  /**
   * Get publishers by category.
   * Note: API doesn't support category filter directly, so we search instead.
   */
  async listByCategory(category: string): Promise<Publisher[]> {
    const { data, error } = await listStorePublishers({
      query: { search: category },
      throwOnError: false,
    });
    if (error) {
      throw new Error("Failed to list publishers by category");
    }
    const rawPublishers = data?.data || [];
    return rawPublishers.map(transformPublisher);
  },
};
