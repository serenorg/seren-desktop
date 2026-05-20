// ABOUTME: Regression coverage for logged-out employee sidebar polling.
// ABOUTME: Guards against authenticated employee requests before sign-in.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EmployeeSummary } from "@/lib/employees/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = resolve(__dirname, "../..");

const { archivedListMock, detailMock, listMock } = vi.hoisted(() => ({
  archivedListMock: vi.fn(),
  detailMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock("@/services/employees", () => ({
  employees: {
    get: detailMock,
    list: listMock,
  },
}));

vi.mock("@/services/employees-archive", () => ({
  employeesArchiveStore: {
    list: archivedListMock,
  },
}));

function readSource(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.resetModules();
  listMock.mockReset();
  detailMock.mockReset();
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

describe("EmployeesSection auth gating", () => {
  it("skips employee refreshes while signed out", () => {
    const source = readSource("src/components/sidebar/EmployeesSection.tsx");

    expect(source).toContain('from "@/stores/auth.store"');
    expect(source).toContain("if (!authStore.isAuthenticated)");
    expect(source).toContain("void employeeStore.refresh(options);");
    expect(source).toContain("Sign in to see employees");
  });

  it("skips pending approval polling while signed out", () => {
    const source = readSource("src/components/sidebar/EmployeesSection.tsx");
    const refreshPendingStart = source.indexOf("const refreshPending = async");
    const approvalCall = source.indexOf("employeeApprovals.listOrg");

    expect(refreshPendingStart).toBeGreaterThanOrEqual(0);
    expect(approvalCall).toBeGreaterThan(refreshPendingStart);
    expect(source.slice(refreshPendingStart, approvalCall)).toContain(
      "if (!authStore.isAuthenticated)",
    );
    expect(source.slice(approvalCall)).toContain(
      "|| !authStore.isAuthenticated",
    );
    expect(source).toContain("pendingRefreshSeq += 1;");
  });

  it("clears stale employee errors on logout reset", async () => {
    const { employeeStore } = await import("@/stores/employees.store");

    detailMock.mockRejectedValue(new Error("stale detail"));
    await employeeStore.loadDetail("dep_1");

    expect(employeeStore.detailError("dep_1")).toBe("stale detail");

    employeeStore.clear();

    expect(employeeStore.error).toBeNull();
    expect(employeeStore.detailError("dep_1")).toBeUndefined();
    expect(employeeStore.employees).toEqual([]);
    expect(employeeStore.archived).toEqual([]);
  });

  it("ignores employee roster refreshes that resolve after logout reset", async () => {
    const { employeeStore } = await import("@/stores/employees.store");
    const list = createDeferred<EmployeeSummary[]>();

    listMock.mockReturnValue(list.promise);
    archivedListMock.mockResolvedValue([]);

    const refresh = employeeStore.refresh();
    employeeStore.clear();
    list.resolve([
      {
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
      },
    ]);
    await refresh;

    expect(employeeStore.employees).toEqual([]);
    expect(employeeStore.loading).toBe(false);
    expect(employeeStore.lastLoadedAt).toBeNull();
  });

  it("ignores employee detail loads that resolve after logout reset", async () => {
    const { employeeStore } = await import("@/stores/employees.store");
    const detail = createDeferred<unknown>();

    detailMock.mockReturnValue(detail.promise);

    const load = employeeStore.loadDetail("dep_1");
    employeeStore.clear();
    detail.resolve({
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
    });
    const result = await load;

    expect(result).toBeNull();
    expect(employeeStore.detail("dep_1")).toBeUndefined();
    expect(employeeStore.employees).toEqual([]);
  });

  it("ignores employee detail errors that resolve after logout reset", async () => {
    const { employeeStore } = await import("@/stores/employees.store");
    const detail = createDeferred<unknown>();

    detailMock.mockReturnValue(detail.promise);

    const load = employeeStore.loadDetail("dep_1");
    employeeStore.clear();
    detail.reject(new Error("stale detail after logout"));
    const result = await load;

    expect(result).toBeNull();
    expect(employeeStore.detailError("dep_1")).toBeUndefined();
  });
});
