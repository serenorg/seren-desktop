// ABOUTME: Publisher catalog service for fetching publisher data from Seren API.
// ABOUTME: Handles listing publishers, getting details, and search suggestions.

import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/tauri-bridge";

/**
 * Publisher pricing information.
 */
export interface PublisherPricing {
  price_per_call: string;
  price_per_query?: string;
  min_charge?: string;
  max_charge?: string;
}

/**
 * Publisher data structure from Seren API.
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
}

/**
 * API response wrapper for publisher list.
 */
interface PublisherListResponse {
  publishers: Publisher[];
}

/**
 * API response wrapper for publisher suggestions.
 */
interface SuggestResponse {
  suggestions: Publisher[];
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
    const response = await appFetch(`${apiBase}/agent/publishers`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || "Failed to list publishers");
    }

    const data: PublisherListResponse = await response.json();
    return data.publishers || [];
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

    return response.json();
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

    const data: PublisherListResponse = await response.json();
    return data.publishers || [];
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

    const data: SuggestResponse = await response.json();
    return data.suggestions || [];
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

    const data: PublisherListResponse = await response.json();
    return data.publishers || [];
  },
};
