// ABOUTME: Employees store - reactive list of deployed virtual employees.
// ABOUTME: Drives the sidebar Employees section and the detail pane.

import { createStore } from "solid-js/store";
import type {
  EmployeeDetail,
  EmployeeStatus,
  EmployeeSummary,
} from "@/lib/employees/types";
import { employees as svc } from "@/services/employees";

interface EmployeesState {
  employees: EmployeeSummary[];
  details: Record<string, EmployeeDetail>;
  loading: boolean;
  error: string | null;
  detailErrors: Record<string, string>;
  lastLoadedAt: number | null;
}

const [state, setState] = createStore<EmployeesState>({
  employees: [],
  details: {},
  loading: false,
  error: null,
  detailErrors: {},
  lastLoadedAt: null,
});

const ORDER_KEY = "seren:employeeOrder";

function loadOrder(): string[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function persistOrder(ids: string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch {
    // localStorage can fail in private mode or quota; ordering is non-critical.
  }
}

function applyOrder(rows: EmployeeSummary[]): EmployeeSummary[] {
  const order = loadOrder();
  if (order.length === 0) return rows;
  const indexOf = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  return [...rows].sort((a, b) => {
    const ia = indexOf(a.id);
    const ib = indexOf(b.id);
    if (ia === ib) return a.name.localeCompare(b.name);
    return ia - ib;
  });
}

export const employeeStore = {
  get employees(): EmployeeSummary[] {
    return state.employees;
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

  detail(id: string): EmployeeDetail | undefined {
    return state.details[id];
  },

  byId(id: string): EmployeeSummary | undefined {
    return state.employees.find((emp) => emp.id === id);
  },

  bySlug(slug: string): EmployeeSummary | undefined {
    return state.employees.find((emp) => emp.slug === slug);
  },

  detailError(id: string): string | undefined {
    return state.detailErrors[id];
  },

  async refresh(): Promise<void> {
    setState("loading", true);
    setState("error", null);
    try {
      const list = await svc.list();
      const ordered = applyOrder(list);
      setState("employees", ordered);
      setState("lastLoadedAt", Date.now());
      persistOrder(ordered.map((row) => row.id));
    } catch (err) {
      setState("error", err instanceof Error ? err.message : String(err));
    } finally {
      setState("loading", false);
    }
  },

  async loadDetail(id: string): Promise<EmployeeDetail | null> {
    try {
      const detail = await svc.get(id);
      setState("details", id, detail);
      setState("employees", (rows) =>
        rows.map((row) => (row.id === id ? { ...row, ...detail } : row)),
      );
      setState("detailErrors", (prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return detail;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState("detailErrors", id, message);
      return null;
    }
  },

  upsert(employee: EmployeeSummary): void {
    setState("employees", (rows) => {
      const idx = rows.findIndex((row) => row.id === employee.id);
      if (idx === -1) return applyOrder([...rows, employee]);
      const next = [...rows];
      next[idx] = { ...next[idx], ...employee };
      return next;
    });
    persistOrder(state.employees.map((row) => row.id));
  },

  remove(id: string): void {
    setState("employees", (rows) => rows.filter((row) => row.id !== id));
    setState("details", (prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setState("detailErrors", (prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    persistOrder(state.employees.map((row) => row.id));
  },

  setStatus(id: string, status: EmployeeStatus): void {
    setState("employees", (rows) =>
      rows.map((row) => (row.id === id ? { ...row, status } : row)),
    );
  },

  reorder(
    sourceId: string,
    targetId: string,
    position: "before" | "after",
  ): void {
    const rows = state.employees;
    const source = rows.find((row) => row.id === sourceId);
    if (!source) return;
    const filtered = rows.filter((row) => row.id !== sourceId);
    const targetIdx = filtered.findIndex((row) => row.id === targetId);
    if (targetIdx === -1) return;
    const insertAt = position === "before" ? targetIdx : targetIdx + 1;
    const next = [...filtered];
    next.splice(insertAt, 0, source);
    setState("employees", next);
    persistOrder(next.map((row) => row.id));
  },
};
