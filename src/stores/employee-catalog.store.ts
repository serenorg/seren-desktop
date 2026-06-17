// ABOUTME: Reactive desktop store for the public Seren Employee role catalog.
// ABOUTME: Separate from deployed employees.store, which tracks running agent instances.

import { createStore } from "solid-js/store";
import type {
  EmployeeCatalogCluster,
  EmployeeCatalogItem,
} from "@/api/employee-catalog";
import { fetchEmployeeCatalog } from "@/api/employee-catalog";

interface EmployeeCatalogState {
  employees: EmployeeCatalogItem[];
  clusters: EmployeeCatalogCluster[];
  loading: boolean;
  error: string | null;
  lastLoadedAt: number | null;
}

const [state, setState] = createStore<EmployeeCatalogState>({
  employees: [],
  clusters: [],
  loading: false,
  error: null,
  lastLoadedAt: null,
});

export const employeeCatalogStore = {
  get employees(): EmployeeCatalogItem[] {
    return state.employees;
  },

  get clusters(): EmployeeCatalogCluster[] {
    return state.clusters;
  },

  get loading(): boolean {
    return state.loading;
  },

  get error(): string | null {
    return state.error;
  },

  get lastLoadedAt(): number | null {
    return state.lastLoadedAt;
  },

  bySlug(slug: string): EmployeeCatalogItem | undefined {
    return state.employees.find((employee) => employee.slug === slug);
  },

  async refresh(): Promise<void> {
    setState("loading", true);
    setState("error", null);

    try {
      const catalog = await fetchEmployeeCatalog();
      setState("employees", catalog.employees);
      setState("clusters", catalog.clusters);
      setState("lastLoadedAt", Date.now());
    } catch (error) {
      setState("error", error instanceof Error ? error.message : String(error));
    } finally {
      setState("loading", false);
    }
  },

  reset(): void {
    setState({
      employees: [],
      clusters: [],
      loading: false,
      error: null,
      lastLoadedAt: null,
    });
  },
};
