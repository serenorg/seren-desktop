// ABOUTME: Local archived-employees store - snapshots of deleted virtual employees.
// ABOUTME: Talks to the Tauri SQLite layer; the cloud roster never returns archived ids.

import { invoke } from "@tauri-apps/api/core";
import type { ArchivedEmployee, EmployeeMode } from "@/lib/employees/types";

interface ArchivedEmployeeRow {
  id: string;
  slug: string;
  name: string;
  mode: string;
  avatar_seed: string;
  archived_at: number;
}

function rowToArchived(row: ArchivedEmployeeRow): ArchivedEmployee {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    mode: row.mode as EmployeeMode,
    avatarSeed: row.avatar_seed,
    archivedAt: new Date(row.archived_at).toISOString(),
  };
}

export const employeesArchiveStore = {
  async archive(
    employee: Pick<
      ArchivedEmployee,
      "id" | "slug" | "name" | "mode" | "avatarSeed"
    >,
  ): Promise<void> {
    await invoke("archive_employee", {
      id: employee.id,
      slug: employee.slug,
      name: employee.name,
      mode: employee.mode,
      avatarSeed: employee.avatarSeed,
      archivedAt: Date.now(),
    });
  },

  async list(): Promise<ArchivedEmployee[]> {
    const rows = await invoke<ArchivedEmployeeRow[]>("list_archived_employees");
    return rows.map(rowToArchived);
  },

  async remove(id: string): Promise<void> {
    await invoke("delete_archived_employee", { id });
  },

  async cascadeDeleteChats(employeeId: string): Promise<number> {
    return invoke<number>("delete_conversations_by_employee", {
      employeeId,
    });
  },
};
