// ABOUTME: Website handoff client for completed Seren Employee intake notes.
// ABOUTME: Persists the general intake and carries the Calendly scheduling URL.

import { appFetch } from "@/lib/fetch";
import { getToken } from "@/lib/tauri-bridge";
import { websiteApiUrl } from "@/services/telemetry";

export const EMPLOYEE_INTAKE_CALENDLY_URL = "https://calendly.com/taariq/30min";

export interface GeneralEmployeeIntakeInput {
  selectedEmployeeSlug: string | null;
  goals: string;
  requirements: string;
  tools: string;
  discussionNotes: string;
}

export interface GeneralEmployeeIntakePayload {
  selected_employee_slug: string | null;
  goals: string;
  requirements: string;
  tools: string;
  discussion_notes: string;
  calendly_url: string;
}

export function buildGeneralEmployeeIntakePayload(
  input: GeneralEmployeeIntakeInput,
): GeneralEmployeeIntakePayload {
  return {
    selected_employee_slug: input.selectedEmployeeSlug,
    goals: input.goals.trim(),
    requirements: input.requirements.trim(),
    tools: input.tools.trim(),
    discussion_notes: input.discussionNotes.trim(),
    calendly_url: EMPLOYEE_INTAKE_CALENDLY_URL,
  };
}

export async function submitGeneralEmployeeIntake(
  input: GeneralEmployeeIntakeInput,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = await getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await appFetch(
    websiteApiUrl("/api/general-interview-submissions"),
    {
      method: "POST",
      headers,
      body: JSON.stringify(buildGeneralEmployeeIntakePayload(input)),
    },
  );

  if (!response.ok) {
    let message = `Failed to submit intake: HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.error === "string") {
        message = body.error;
      } else if (typeof body?.message === "string") {
        message = body.message;
      }
    } catch {
      // Keep the HTTP status fallback.
    }
    throw new Error(message);
  }
}
