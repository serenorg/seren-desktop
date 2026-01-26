// ABOUTME: Publisher catalog service for fetching publisher data from Seren API.
// ABOUTME: Handles listing publishers, getting details, and search suggestions.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/tauri-bridge";

/**
 * Publisher pricing information (normalized for UI).
 */
export interface PublisherPricing {
  price_per_call?: string;
  price_per_query?: string;
  min_charge?: string;
  max_charge?: string;
}

/**
 * Publisher data structure (normalized for UI).
 */
export interface Publisher {
  id: string;
  slug: string;
  name: string;
  description: string;
  logo_url: string | null;
  category: string;
  pricing: PublisherPricing;
  capabilities: string[];
  is_verified: boolean;
  is_active: boolean;
  total_queries?: number;
}

/**
 * Raw API publisher structure (as returned by Seren API).
 */
interface RawPublisher {
  id: string;
  slug: string;
  name: string;
  description: string;
  logo_url?: string | null;
  publisher_category?: string;
  category?: string;
  pricing?: Array<{
    price_per_call?: string;
    price_per_query?: string;
    min_charge?: string;
    max_charge?: string;
  }> | PublisherPricing;
  capabilities?: string[];
  use_cases?: string[];
  is_verified?: boolean;
  is_active?: boolean;
  total_queries?: number;
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

  // Handle pricing - API returns array, we want first item as object
  let pricing: PublisherPricing = {};
  if (Array.isArray(raw.pricing) && raw.pricing.length > 0) {
    pricing = raw.pricing[0];
  } else if (raw.pricing && !Array.isArray(raw.pricing)) {
    pricing = raw.pricing;
  }

  // Handle capabilities - use use_cases if capabilities is empty
  const capabilities = (raw.capabilities && raw.capabilities.length > 0)
    ? raw.capabilities
    : (raw.use_cases || []);

  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    description: raw.description,
    logo_url: logoUrl || null,
    category: raw.publisher_category || raw.category || "unknown",
    pricing,
    capabilities,
    is_verified: raw.is_verified ?? false,
    is_active: raw.is_active ?? true,
    total_queries: raw.total_queries,
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
    console.log("[Catalog] Response data:", data);

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
   * Returns matching publishers based on name, description, or capabilities.
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
    const rawPublishers: RawPublisher[] = data.data || data.publishers || [];
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
    const rawPublishers: RawPublisher[] = data.data || data.suggestions || [];
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
    const rawPublishers: RawPublisher[] = data.data || data.publishers || [];
    return rawPublishers.map(transformPublisher);
  },
};
