---
name: Feature Request
about: Allow user-selectable search engines for webfetch
title: "[FEATURE] Configurable Search Engine for WebFetch"
labels: ["type: feature"]
assignees: ["taariq"]
---

## Problem

Currently, `seren_web_fetch` defaults to a single search provider (identified as DuckDuckGo/Microsoft Bing syndication via the Seren Gateway). Users have no control over the privacy implications or the quality of search results provided by this default.

## Proposed Solution

1.  **Settings UI**: Add a "Search" section in the Seren Desktop settings where users can choose their preferred search engine (e.g., SearXNG, Mojeek, Brave Search, Google, or the default Seren/DDG provider).
2.  **Slash Command**: Implement a `/search-engine <provider>` command in the chat interface to allow quick toggling between engines sessions.
3.  **MCP Tool Update**: Modify the tool call logic to pass a `provider` parameter to the `seren_web_fetch` MCP tool.

## Alternatives Considered

- Using a local-only search engine scraper (difficult to maintain across OS versions).
- Direct integration with search APIs (requires users to manage multiple API keys).

## Additional Context

This feature is critical for users who want to avoid feeding their local project context and search history into the Microsoft/Google data ecosystems. Assign to @taariq.
