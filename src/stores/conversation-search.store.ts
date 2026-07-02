// ABOUTME: UI state and actions for conversation history search.
// ABOUTME: Shares one result set between the spotlight overlay and full-pane view.

import { createStore } from "solid-js/store";
import {
  type ConversationHit,
  type ConversationKind,
  type ConversationSearchFilters,
  searchConversations,
} from "@/services/conversation-search";
import { threadStore } from "@/stores/thread.store";

export type ConversationSearchMode = "overlay" | "full";
export type ConversationKindFilter = "all" | ConversationKind;

export interface ConversationSearchUiFilters {
  kind: ConversationKindFilter;
  projectRoot: string | null;
  fromDate: string;
  toDate: string;
  includeArchived: boolean;
}

interface ConversationSearchState {
  open: boolean;
  mode: ConversationSearchMode;
  pendingFocus: boolean;
  query: string;
  filters: ConversationSearchUiFilters;
  results: ConversationHit[];
  loading: boolean;
  searched: boolean;
  semanticUnavailable: boolean;
  semanticUnavailableReason: string | null;
}

const [state, setState] = createStore<ConversationSearchState>({
  open: false,
  mode: "overlay",
  pendingFocus: false,
  query: "",
  filters: {
    kind: "all",
    projectRoot: null,
    fromDate: "",
    toDate: "",
    includeArchived: false,
  },
  results: [],
  loading: false,
  searched: false,
  semanticUnavailable: false,
  semanticUnavailableReason: null,
});

let searchRequest = 0;

function dayStartMs(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
}

function dayEndMs(value: string): number | null {
  if (!value) return null;
  const parsed = new Date(`${value}T23:59:59.999`);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
}

function serviceFilters(): ConversationSearchFilters {
  const filters = state.filters;
  return {
    kinds: filters.kind === "all" ? [] : [filters.kind],
    projectRoot: filters.projectRoot,
    afterMs: dayStartMs(filters.fromDate),
    beforeMs: dayEndMs(filters.toDate),
    includeArchived: filters.includeArchived,
  };
}

function setEmptySearchState() {
  setState({
    results: [],
    loading: false,
    searched: false,
    semanticUnavailable: false,
    semanticUnavailableReason: null,
  });
}

export const conversationSearchStore = {
  state,

  openOverlay(prefill?: string) {
    setState({
      open: true,
      mode: "overlay",
      pendingFocus: true,
    });
    if (prefill !== undefined) setState("query", prefill);
  },

  close() {
    setState({
      open: false,
      mode: "overlay",
      pendingFocus: false,
    });
  },

  expandToFull() {
    setState({
      open: false,
      mode: "full",
      pendingFocus: true,
    });
  },

  consumeFocusRequest() {
    setState("pendingFocus", false);
  },

  setQuery(query: string) {
    setState("query", query);
  },

  setKind(kind: ConversationKindFilter) {
    setState("filters", "kind", kind);
  },

  setProjectRoot(projectRoot: string | null) {
    setState("filters", "projectRoot", projectRoot);
  },

  setFromDate(value: string) {
    setState("filters", "fromDate", value);
  },

  setToDate(value: string) {
    setState("filters", "toDate", value);
  },

  setIncludeArchived(value: boolean) {
    setState("filters", "includeArchived", value);
  },

  clearFilters() {
    setState("filters", {
      kind: "all",
      projectRoot: null,
      fromDate: "",
      toDate: "",
      includeArchived: false,
    });
  },

  async runSearch(limit = 80) {
    const query = state.query.trim();
    const request = ++searchRequest;
    if (!query) {
      setEmptySearchState();
      return;
    }

    setState("loading", true);
    const result = await searchConversations(query, {
      limit,
      filters: serviceFilters(),
    });
    if (request !== searchRequest) return;
    setState({
      results: result.hits,
      loading: false,
      searched: true,
      semanticUnavailable: result.semanticUnavailable,
      semanticUnavailableReason: result.semanticUnavailableReason ?? null,
    });
  },

  openHit(hit: ConversationHit) {
    threadStore.selectThread(hit.conversationId, hit.kind);
    threadStore.requestMessageScroll(hit.conversationId, hit.messageId);
    this.close();
  },
};
