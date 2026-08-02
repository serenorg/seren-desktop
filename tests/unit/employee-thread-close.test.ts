// ABOUTME: Guards the close affordance shared by active and archived employee chats.
// ABOUTME: Protects propagation-safe wiring to the existing thread archive path.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve("src/components/sidebar/EmployeesSection.tsx"),
  "utf8",
);

describe("employee thread close control", () => {
  it("wires both employee thread groups to the propagation-safe archive row", () => {
    const rowStart = source.indexOf("const EmployeeThreadRow");
    const sectionStart = source.indexOf("export const EmployeesSection");
    const rowSource = source.slice(rowStart, sectionStart);

    expect(rowStart).toBeGreaterThanOrEqual(0);
    expect(sectionStart).toBeGreaterThan(rowStart);
    expect(source.match(/<EmployeeThreadRow/g)).toHaveLength(2);
    expect(source).toContain("archived={true}");
    expect(rowSource).toContain("event.stopPropagation();");
    expect(rowSource).toContain(
      "await threadStore.archiveThread(props.thread.id, props.thread.kind);",
    );
    expect(rowSource).toContain(
      "aria-label={`Close thread ${props.thread.title}`}",
    );
    expect(rowSource).toContain("group-focus-within:opacity-100");
  });
});
