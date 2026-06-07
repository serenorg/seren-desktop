// ABOUTME: Built-in Tier-1 meeting note templates for Meeting Mode.
// ABOUTME: Provides stable ids that settings and meeting records can reference.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct MeetingTemplate {
    pub id: &'static str,
    pub name: &'static str,
    pub prompt: &'static str,
}

pub const BUILT_IN_MEETING_TEMPLATES: &[MeetingTemplate] = &[
    MeetingTemplate {
        id: "sales_call",
        name: "Sales Call",
        prompt: "Summarize qualification, pain, stakeholders, objections, decision process, and next steps.",
    },
    MeetingTemplate {
        id: "discovery",
        name: "Discovery",
        prompt: "Capture goals, constraints, current workflow, urgency, budget signals, and unanswered questions.",
    },
    MeetingTemplate {
        id: "one_on_one",
        name: "1:1",
        prompt: "Capture wins, blockers, feedback, decisions, commitments, and follow-up dates.",
    },
    MeetingTemplate {
        id: "user_interview",
        name: "User Interview",
        prompt: "Capture jobs-to-be-done, quotes, workflow details, pain points, workarounds, and product opportunities.",
    },
    MeetingTemplate {
        id: "stand_up",
        name: "Stand-up",
        prompt: "Capture yesterday, today, blockers, owners, and commitments.",
    },
];

pub fn default_template_id() -> &'static str {
    "discovery"
}
