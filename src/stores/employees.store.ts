// ABOUTME: Employees store - reactive list of deployed virtual employees.
// ABOUTME: Drives the sidebar Employees section and the detail pane.

import { createStore } from "solid-js/store";
import type {
  ArchivedEmployee,
  EmployeeDetail,
  EmployeeStatus,
  EmployeeSummary,
} from "@/lib/employees/types";
import { syncCloudEmployeeChats } from "@/services/employee-chat-sync";
import { employees as svc } from "@/services/employees";
import { employeesArchiveStore } from "@/services/employees-archive";

interface EmployeesState {
  employees: EmployeeSummary[];
  archived: ArchivedEmployee[];
  details: Record<string, EmployeeDetail>;
  loading: boolean;
  error: string | null;
  detailErrors: Record<string, string>;
  lastLoadedAt: number | null;
}

const [state, setState] = createStore<EmployeesState>({
  employees: [],
  archived: [],
  details: {},
  loading: false,
  error: null,
  detailErrors: {},
  lastLoadedAt: null,
});

let resetGeneration = 0;

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

function employeeSummariesEqual(
  left: EmployeeSummary[],
  right: EmployeeSummary[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    if (!other) return false;
    return JSON.stringify(row) === JSON.stringify(other);
  });
}

function archivedEmployeesEqual(
  left: ArchivedEmployee[],
  right: ArchivedEmployee[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    if (!other) return false;
    return JSON.stringify(row) === JSON.stringify(other);
  });
}

export const employeeStore = {
  get employees(): EmployeeSummary[] {
    return state.employees;
  },

  get archived(): ArchivedEmployee[] {
    return state.archived;
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

  archivedById(id: string): ArchivedEmployee | undefined {
    return state.archived.find((emp) => emp.id === id);
  },

  bySlug(slug: string): EmployeeSummary | undefined {
    return state.employees.find((emp) => emp.slug === slug);
  },

  detailError(id: string): string | undefined {
    return state.detailErrors[id];
  },

  async refresh(options?: { background?: boolean }): Promise<void> {
    const background = options?.background === true;
    const generation = resetGeneration;
    if (!background) {
      setState("loading", true);
      setState("error", null);
    }
    try {
      // Live list is fatal on failure (drives the whole employees pane).
      // Archived list is best-effort: a corrupt local SQLite must not mask
      // a successful cloud roster fetch. Mirrors loadArchived() semantics.
      const [listResult, archivedResult] = await Promise.allSettled([
        svc.list(),
        employeesArchiveStore.list(),
      ]);

      if (generation !== resetGeneration) {
        return;
      }

      if (listResult.status === "rejected") {
        const err = listResult.reason;
        if (!background || state.lastLoadedAt === null) {
          setState("error", err instanceof Error ? err.message : String(err));
        }
        return;
      }

      const ordered = applyOrder(listResult.value);
      const employeesChanged = !employeeSummariesEqual(
        state.employees,
        ordered,
      );
      if (employeesChanged) {
        setState("employees", ordered);
      }
      if (archivedResult.status === "fulfilled") {
        const archivedChanged = !archivedEmployeesEqual(
          state.archived,
          archivedResult.value,
        );
        if (archivedChanged) {
          setState("archived", archivedResult.value);
        }
      } else {
        console.warn(
          "Failed to load archived employees:",
          archivedResult.reason,
        );
        if (!background && !archivedEmployeesEqual(state.archived, [])) {
          setState("archived", []);
        }
      }
      if (!background && state.error !== null) {
        setState("error", null);
      }
      if (!background || state.lastLoadedAt === null) {
        setState("lastLoadedAt", Date.now());
      }
      if (employeesChanged) {
        persistOrder(ordered.map((row) => row.id));
      }
      void syncCloudEmployeeChats(ordered, {
        shouldContinue: () => generation === resetGeneration,
      }).catch((err) => {
        console.warn("Failed to sync cloud employee chats:", err);
      });
    } finally {
      if (!background && generation === resetGeneration) {
        setState("loading", false);
      }
    }
  },

  clear(): void {
    resetGeneration += 1;
    setState({
      employees: [],
      archived: [],
      details: {},
      loading: false,
      error: null,
      detailErrors: {},
      lastLoadedAt: null,
    });
  },

  async loadArchived(): Promise<void> {
    try {
      const archived = await employeesArchiveStore.list();
      setState("archived", archived);
    } catch (err) {
      // Archived list is best-effort; surface to console only.
      console.warn("Failed to load archived employees:", err);
    }
  },

  addArchived(employee: ArchivedEmployee): void {
    setState("archived", (rows) => {
      const idx = rows.findIndex((row) => row.id === employee.id);
      if (idx === -1) {
        return [employee, ...rows];
      }
      const next = [...rows];
      next[idx] = employee;
      return next;
    });
  },

  removeArchived(id: string): void {
    setState("archived", (rows) => rows.filter((row) => row.id !== id));
  },

  async loadDetail(id: string): Promise<EmployeeDetail | null> {
    // Same guard as `refresh()`: a detail fetch in flight at logout must
    // not repopulate `details`/`employees`/`detailErrors` after `clear()`
    // has wiped them, or the next sign-in inherits stale rows from the
    // previous session.
    const generation = resetGeneration;
    try {
      const detail = await svc.get(id);
      if (generation !== resetGeneration) return null;
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
      if (generation !== resetGeneration) return null;
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
