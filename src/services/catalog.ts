// ABOUTME: Publisher catalog service for fetching publisher data from Seren API.
// ABOUTME: Handles listing publishers, getting details, and search suggestions.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/tauri-bridge";

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

/**
 * Raw API publisher structure (as returned by Seren API).
 */
interface RawPublisher {
  id: string;
  slug: string;
  name: string;
  resource_name?: string | null;
  resource_description?: string | null;
  description?: string;
  logo_url?: string | null;
  publisher_type?: string;
  publisher_category?: string;
  category?: string;
  billing_model?: string | null;
  // Pricing can come as top-level fields or in pricing array
  price_per_call?: string | number | null;
  base_price_per_1000_rows?: string | number | null;
  price_per_execution?: string | number | null;
  pricing?: Array<{
    price_per_call?: string | number;
    base_price_per_1000_rows?: string | number;
    price_per_execution?: string | number;
  }>;
  // Stats
  total_transactions?: number;
  unique_agents_served?: number;
  total_queries?: number;
  // Metadata
  categories?: string[];
  capabilities?: string[];
  use_cases?: string[];
  is_verified?: boolean;
  is_active?: boolean;
}

/**
 * Parse a numeric value that could be string or number.
 */
function parseNumericPrice(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "string" ? parseFloat(value) : value;
  return isNaN(num) ? null : num;
}

/**
 * Transform raw API publisher to normalized UI publisher.
 */
function transformPublisher(raw: RawPublisher): Publisher {
  // Handle logo_url - convert relative paths to absolute URLs
  let logoUrl = raw.logo_url;
  if (logoUrl && logoUrl.startsWith("/")) {
    logoUrl = `${apiBase}${logoUrl}`;
  }

  // Determine publisher type
  let publisherType: PublisherType = "api";
  if (raw.publisher_type === "database") {
    publisherType = "database";
  } else if (raw.publisher_type === "mcp") {
    publisherType = "mcp";
  } else if (raw.publisher_type === "compute") {
    publisherType = "compute";
  } else if (raw.publisher_category === "database" || raw.category === "database") {
    publisherType = "database";
  }

  // Determine billing model
  let billingModel: BillingModel | null = null;
  if (raw.billing_model === "x402_per_request" || raw.billing_model === "prepaid_credits") {
    billingModel = raw.billing_model;
  }

  // Extract pricing - check top-level fields first, then pricing array
  let pricePerCall = parseNumericPrice(raw.price_per_call);
  let basePricePer1000Rows = parseNumericPrice(raw.base_price_per_1000_rows);
  let pricePerExecution = parseNumericPrice(raw.price_per_execution);

  // Fallback to pricing array if available
  if (Array.isArray(raw.pricing) && raw.pricing.length > 0) {
    const pricing = raw.pricing[0];
    if (pricePerCall === null) {
      pricePerCall = parseNumericPrice(pricing.price_per_call);
    }
    if (basePricePer1000Rows === null) {
      basePricePer1000Rows = parseNumericPrice(pricing.base_price_per_1000_rows);
    }
    if (pricePerExecution === null) {
      pricePerExecution = parseNumericPrice(pricing.price_per_execution);
    }
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
    total_transactions: raw.total_transactions || raw.total_queries || 0,
    unique_agents_served: raw.unique_agents_served || 0,
    categories,
    is_verified: raw.is_verified ?? false,
    is_active: raw.is_active ?? true,
  };
}

/**
 * Get authorization headers for API requests.
 */
async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated");
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
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
    if (publisher.price_per_execution !== null && publisher.price_per_execution > 0) {
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
 */
export const catalog = {
  /**
   * List all active publishers.
   */
  async list(): Promise<Publisher[]> {
    const headers = await getAuthHeaders();
    const url = `${apiBase}/agent/publishers`;
    console.log("[Catalog] Fetching publishers from:", url);

    const response = await appFetch(url, {
      method: "GET",
      headers,
    });

    console.log("[Catalog] Response status:", response.status);

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      console.error("[Catalog] Error fetching publishers:", error);
      throw new Error(error.message || "Failed to list publishers");
    }

    const data = await response.json();

    // Handle { data: [...] }, { publishers: [...] }, and direct array responses
    const rawPublishers: RawPublisher[] = Array.isArray(data) ? data : (data.data || data.publishers || []);
    console.log("[Catalog] Found", rawPublishers.length, "publishers");

    // Transform to normalized structure
    const publishers = rawPublishers.map(transformPublisher);
    return publishers;
  },

  /**
   * Get a single publisher by slug.
   */
  async get(slug: string): Promise<Publisher> {
    const headers = await getAuthHeaders();
    const response = await appFetch(`${apiBase}/agent/publishers/${encodeURIComponent(slug)}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to get publisher");
    }

    const raw: RawPublisher = await response.json();
    return transformPublisher(raw);
  },

  /**
   * Search publishers by query.
   * Returns matching publishers based on name, description, or categories.
   */
  async search(query: string): Promise<Publisher[]> {
    if (!query.trim()) {
      return this.list();
    }

    const headers = await getAuthHeaders();
    const params = new URLSearchParams({ search: query });
    const response = await appFetch(`${apiBase}/agent/publishers?${params}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to search publishers");
    }

    const data = await response.json();
    const rawPublishers: RawPublisher[] = Array.isArray(data) ? data : (data.data || data.publishers || []);
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

    const headers = await getAuthHeaders();
    const params = new URLSearchParams({ q: query });
    const response = await appFetch(`${apiBase}/agent/publishers/suggest?${params}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      // Suggestions are optional, return empty on error
      return [];
    }

    const data = await response.json();
    const rawPublishers: RawPublisher[] = Array.isArray(data) ? data : (data.data || data.suggestions || []);
    return rawPublishers.map(transformPublisher);
  },

  /**
   * Get publishers by category.
   */
  async listByCategory(category: string): Promise<Publisher[]> {
    const headers = await getAuthHeaders();
    const params = new URLSearchParams({ category });
    const response = await appFetch(`${apiBase}/agent/publishers?${params}`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to list publishers by category");
    }

    const data = await response.json();
    const rawPublishers: RawPublisher[] = Array.isArray(data) ? data : (data.data || data.publishers || []);
    return rawPublishers.map(transformPublisher);
  },
};
