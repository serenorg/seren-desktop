// ABOUTME: Panel for browsing and reading MCP resources.
// ABOUTME: Shows available resources across connected servers with content preview.

import { createSignal, For, Show, type Component } from "solid-js";
import { mcpClient } from "@/lib/mcp/client";
import type { McpResource } from "@/lib/mcp/types";
import "./McpResourcesPanel.css";

interface ResourceContent {
  serverName: string;
  uri: string;
  content: unknown;
  isLoading: boolean;
  error: string | null;
}

export const McpResourcesPanel: Component = () => {
  const [selectedResource, setSelectedResource] = createSignal<{
    serverName: string;
    resource: McpResource;
  } | null>(null);
  const [resourceContent, setResourceContent] = createSignal<ResourceContent | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");

  const resources = () => mcpClient.getAllResources();

  const filteredResources = () => {
    const query = searchQuery().toLowerCase();
    if (!query) return resources();
    return resources().filter(
      ({ resource }) =>
        resource.name.toLowerCase().includes(query) ||
        resource.uri.toLowerCase().includes(query) ||
        (resource.description?.toLowerCase().includes(query) ?? false)
    );
  };

  async function selectResource(serverName: string, resource: McpResource): Promise<void> {
    setSelectedResource({ serverName, resource });
    setResourceContent({
      serverName,
      uri: resource.uri,
      content: null,
      isLoading: true,
      error: null,
    });

    try {
      const content = await mcpClient.readResource(serverName, resource.uri);
      setResourceContent({
        serverName,
        uri: resource.uri,
        content,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      setResourceContent({
        serverName,
        uri: resource.uri,
        content: null,
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function formatContent(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (content && typeof content === "object") {
      // Handle MCP resource response format
      const obj = content as Record<string, unknown>;
      if (obj.contents && Array.isArray(obj.contents)) {
        return (obj.contents as Array<{ text?: string }>)
          .map((c) => c.text || JSON.stringify(c, null, 2))
          .join("\n\n");
      }
    }
    return JSON.stringify(content, null, 2);
  }

  function getMimeIcon(mimeType?: string): string {
    if (!mimeType) return "📄";
    if (mimeType.startsWith("text/")) return "📝";
    if (mimeType.startsWith("image/")) return "🖼️";
    if (mimeType.startsWith("application/json")) return "📋";
    if (mimeType.includes("javascript")) return "⚡";
    return "📄";
  }

  return (
    <div class="mcp-resources-panel">
      <div class="resources-sidebar">
        <div class="sidebar-header">
          <h3>Resources</h3>
          <span class="resource-count">{resources().length}</span>
        </div>

        <div class="search-box">
          <input
            type="text"
            placeholder="Search resources..."
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
          />
        </div>

        <Show
          when={filteredResources().length > 0}
          fallback={
            <div class="empty-state">
              {resources().length === 0
                ? "No resources available. Connect to an MCP server first."
                : "No resources match your search."}
            </div>
          }
        >
          <div class="resources-list">
            <For each={filteredResources()}>
              {({ serverName, resource }) => {
                const isSelected = () => {
                  const sel = selectedResource();
                  return (
                    sel?.serverName === serverName && sel?.resource.uri === resource.uri
                  );
                };

                return (
                  <button
                    class="resource-item"
                    classList={{ selected: isSelected() }}
                    onClick={() => selectResource(serverName, resource)}
                  >
                    <span class="resource-icon">{getMimeIcon(resource.mimeType)}</span>
                    <div class="resource-info">
                      <span class="resource-name">{resource.name}</span>
                      <span class="resource-uri">{resource.uri}</span>
                    </div>
                    <span class="resource-server">{serverName}</span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <div class="resource-detail">
        <Show
          when={selectedResource()}
          fallback={
            <div class="no-selection">
              Select a resource from the list to view its contents.
            </div>
          }
        >
          {(sel) => (
            <>
              <div class="resource-header">
                <span class="icon">{getMimeIcon(sel().resource.mimeType)}</span>
                <div class="header-info">
                  <h2>{sel().resource.name}</h2>
                  <span class="uri">{sel().resource.uri}</span>
                </div>
                <span class="server-badge">{sel().serverName}</span>
              </div>

              <Show when={sel().resource.description}>
                <p class="resource-description">{sel().resource.description}</p>
              </Show>

              <Show when={sel().resource.mimeType}>
                <div class="mime-type">
                  <span class="label">Type:</span>
                  <span class="value">{sel().resource.mimeType}</span>
                </div>
              </Show>

              <div class="resource-content">
                <div class="content-header">
                  <h4>Content</h4>
                  <Show when={resourceContent()?.content}>
                    <button
                      class="btn-copy"
                      onClick={() => {
                        const content = resourceContent()?.content;
                        if (content) {
                          navigator.clipboard.writeText(formatContent(content));
                        }
                      }}
                    >
                      Copy
                    </button>
                  </Show>
                </div>

                <Show when={resourceContent()?.isLoading}>
                  <div class="loading">Loading resource content...</div>
                </Show>

                <Show when={resourceContent()?.error}>
                  <div class="error">{resourceContent()?.error}</div>
                </Show>

                <Show when={resourceContent()?.content}>
                  <div class="content-viewer">
                    <pre>{formatContent(resourceContent()?.content)}</pre>
                  </div>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>
    </div>
  );
};

export default McpResourcesPanel;
