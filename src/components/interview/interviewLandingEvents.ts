// ABOUTME: Shared event names for the general Seren Employee intake landing.
// ABOUTME: Lets startup and shell wiring open the landing without importing TSX.

export const OPEN_INTERVIEW_LANDING_EVENT = "seren:open-interview-landing";
export const CLOSE_INTERVIEW_LANDING_EVENT = "seren:close-interview-landing";

export type InterviewLandingEventDetail = {
  employee?: string | null;
  source?: string;
};
