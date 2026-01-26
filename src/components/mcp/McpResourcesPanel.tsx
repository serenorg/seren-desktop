// ABOUTME: Panel for browsing and reading MCP resources.
// ABOUTME: Shows available resources across connected servers with content preview.

import { type Component, createSignal, For, Show } from "solid-js";
import { mcpClient } from "@/lib/mcp/client";
import type { McpResource } from "@/lib/mcp/types";

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
  const [resourceContent, setResourceContent] =
    createSignal<ResourceContent | null>(null);
  const [searchQuery, setSearchQuery] = createSignal("");

  const resources = () => mcpClient.getAllResources();

  const filteredResources = () => {
    const query = searchQuery().toLowerCase();
    if (!query) return resources();
    return resources().filter(
      ({ resource }) =>
        resource.name.toLowerCase().includes(query) ||
        resource.uri.toLowerCase().includes(query) ||
        (resource.description?.toLowerCase().includes(query) ?? false),
    );
  };

  async function selectResource(
    serverName: string,
    resource: McpResource,
  ): Promise<void> {
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
    <div class="flex h-full bg-card">
      <div class="w-80 border-r border-[rgba(148,163,184,0.25)] flex flex-col bg-popover">
        <div class="p-4 border-b border-[rgba(148,163,184,0.25)] flex justify-between items-center">
          <h3 class="m-0 text-sm font-semibold">Resources</h3>
          <span class="px-2 py-0.5 bg-accent text-white rounded-xl text-xs font-medium">
            {resources().length}
          </span>
        </div>

        <div class="p-3 border-b border-[rgba(148,163,184,0.25)]">
          <input
            type="text"
            placeholder="Search resources..."
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            class="w-full px-3 py-2 border border-[rgba(148,163,184,0.25)] rounded-md text-[13px] bg-card text-foreground focus:outline-none focus:border-accent focus:shadow-[0_0_0_3px_rgba(59,130,246,0.1)]"
          />
        </div>

        <Show
          when={filteredResources().length > 0}
          fallback={
            <div class="flex items-center justify-center h-full text-muted-foreground text-sm text-center p-6">
              {resources().length === 0
                ? "No resources available. Connect to an MCP server first."
                : "No resources match your search."}
            </div>
          }
        >
          <div class="flex-1 overflow-y-auto p-2">
            <For each={filteredResources()}>
              {({ serverName, resource }) => {
                const isSelected = () => {
                  const sel = selectedResource();
                  return (
                    sel?.serverName === serverName &&
                    sel?.resource.uri === resource.uri
                  );
                };

                return (
                  <button
                    class={`w-full px-3 py-2.5 bg-transparent border-none rounded-md text-left cursor-pointer flex items-center gap-2.5 transition-colors duration-150 ${
                      isSelected()
                        ? "bg-accent text-white"
                        : "hover:bg-[rgba(148,163,184,0.15)]"
                    }`}
                    onClick={() => selectResource(serverName, resource)}
                  >
                    <span class="text-lg shrink-0">
                      {getMimeIcon(resource.mimeType)}
                    </span>
                    <div class="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span class="text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis">
                        {resource.name}
                      </span>
                      <span
                        class={`text-[11px] whitespace-nowrap overflow-hidden text-ellipsis font-mono ${isSelected() ? "opacity-85" : "opacity-70"}`}
                      >
                        {resource.uri}
                      </span>
                    </div>
                    <span
                      class={`text-[10px] shrink-0 ${isSelected() ? "opacity-85" : "opacity-60"}`}
                    >
                      {serverName}
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <div class="flex-1 p-6 overflow-y-auto flex flex-col">
        <Show
          when={selectedResource()}
          fallback={
            <div class="flex items-center justify-center h-full text-muted-foreground text-sm text-center p-6">
              Select a resource from the list to view its contents.
            </div>
          }
        >
          {(sel) => (
            <>
              <div class="flex items-start gap-3 mb-4">
                <span class="text-[32px] shrink-0">
                  {getMimeIcon(sel().resource.mimeType)}
                </span>
                <div class="flex-1 min-w-0">
                  <h2 class="m-0 text-xl font-semibold break-words">
                    {sel().resource.name}
                  </h2>
                  <span class="block text-xs text-muted-foreground font-mono break-all mt-1">
                    {sel().resource.uri}
                  </span>
                </div>
                <span class="px-2.5 py-1 bg-popover rounded-md text-xs text-muted-foreground shrink-0">
                  {sel().serverName}
                </span>
              </div>

              <Show when={sel().resource.description}>
                <p class="text-muted-foreground mb-4 leading-normal">
                  {sel().resource.description}
                </p>
              </Show>

              <Show when={sel().resource.mimeType}>
                <div class="mb-4 text-[13px]">
                  <span class="text-muted-foreground mr-2">Type:</span>
                  <span class="font-mono bg-popover px-2 py-0.5 rounded">
                    {sel().resource.mimeType}
                  </span>
                </div>
              </Show>

              <div class="flex-1 flex flex-col min-h-0">
                <div class="flex justify-between items-center mb-3">
                  <h4 class="m-0 text-sm font-semibold">Content</h4>
                  <Show when={resourceContent()?.content}>
                    <button
                      class="px-3 py-1.5 bg-popover border border-[rgba(148,163,184,0.25)] rounded text-xs cursor-pointer transition-colors duration-150 hover:bg-[rgba(148,163,184,0.15)]"
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
                  <div class="text-muted-foreground text-[13px] p-4">
                    Loading resource content...
                  </div>
                </Show>

                <Show when={resourceContent()?.error}>
                  <div class="p-3 bg-[rgba(239,68,68,0.1)] text-[#dc2626] rounded-md text-[13px]">
                    {resourceContent()?.error}
                  </div>
                </Show>

                <Show when={resourceContent()?.content}>
                  <div class="flex-1 bg-popover border border-[rgba(148,163,184,0.25)] rounded-lg overflow-auto min-h-[200px]">
                    <pre class="m-0 p-4 text-[13px] font-mono whitespace-pre-wrap break-words">
                      {formatContent(resourceContent()?.content)}
                    </pre>
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
