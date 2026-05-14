// ABOUTME: Regression coverage for background employee polling.
// ABOUTME: Ensures no-op polls preserve reactive references and timestamps.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { archivedListMock, listMock } = vi.hoisted(() => ({
  archivedListMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock("@/services/employees", () => ({
  employees: {
    list: listMock,
  },
}));

vi.mock("@/services/employees-archive", () => ({
  employeesArchiveStore: {
    list: archivedListMock,
  },
}));

beforeEach(() => {
  vi.resetModules();
  listMock.mockReset();
  archivedListMock.mockReset();
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
});

describe("employeeStore.refresh", () => {
  it("does not mutate rendered state for unchanged background polls", async () => {
    const { employeeStore } = await import("@/stores/employees.store");

    listMock.mockResolvedValue([]);
    archivedListMock.mockResolvedValue([]);

    await employeeStore.refresh();

    const employees = employeeStore.employees;
    const archived = employeeStore.archived;
    const lastLoadedAt = employeeStore.lastLoadedAt;

    await employeeStore.refresh({ background: true });

    expect(employeeStore.loading).toBe(false);
    expect(employeeStore.error).toBeNull();
    expect(employeeStore.employees).toBe(employees);
    expect(employeeStore.archived).toBe(archived);
    expect(employeeStore.lastLoadedAt).toBe(lastLoadedAt);
  });

  it("preserves the employees reference when the roster is unchanged but non-empty", async () => {
    const { employeeStore } = await import("@/stores/employees.store");

    const summary = {
      id: "dep_1",
      slug: "ops-bot",
      name: "Ops bot",
      mode: "always_on",
      status: "running",
      modelChoice: "standard",
      modelPolicy: "balanced",
      modelId: null,
      cronSchedule: null,
      cronTimezone: null,
      endpointUrl: null,
      activeRevisionId: null,
      errorMessage: null,
      avatarSeed: "ops-bot",
      createdAt: "2026-05-13T00:00:00Z",
      updatedAt: "2026-05-13T00:00:00Z",
    };

    listMock.mockResolvedValue([{ ...summary }]);
    archivedListMock.mockResolvedValue([]);

    await employeeStore.refresh();

    const firstEmployees = employeeStore.employees;
    const firstLastLoadedAt = employeeStore.lastLoadedAt;
    expect(firstEmployees).toHaveLength(1);

    // Backend returns a new array of equivalent rows; the store should keep
    // the existing reference so reactive consumers don't re-render.
    listMock.mockResolvedValue([{ ...summary }]);

    await employeeStore.refresh({ background: true });

    expect(employeeStore.employees).toBe(firstEmployees);
    expect(employeeStore.lastLoadedAt).toBe(firstLastLoadedAt);
    expect(employeeStore.loading).toBe(false);
  });
});
