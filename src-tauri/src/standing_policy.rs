// ABOUTME: Owner/org-defined standing policies that auto-materialize bounded capability leases (#3193-E).
// ABOUTME: A policy holds the same predicates + budgets a human grant does; the resolver mints a lease within them, never wider.

use serde::{Deserialize, Serialize};

use crate::capability_lease::{CapabilityLease, LeaseBudgets, LeasePredicates};

/// A persistent, owner-defined pre-authorization. Unlike a `CapabilityLease` it
/// is **not** conversation-scoped: it lives until the owner disables or deletes
/// it, and the resolver materializes a fresh conversation-scoped lease from it at
/// task start (zero prompts, no human present).
///
/// A policy expresses authority in the *exact same vocabulary* a human "Approve
/// for this task" grant does (`LeasePredicates` + `LeaseBudgets`), so it can only
/// ever pre-authorize *within* those predicates — never widen a call beyond them.
/// The model can `request` scope but can never create, widen, or self-approve a
/// standing policy: policies are written only by the owner settings commands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingPolicy {
    pub id: String,
    /// Human-readable summary shown in the owner settings surface.
    pub label: String,
    /// Disabled policies are ignored by the resolver, so toggling this off stops
    /// all future auto-grants immediately (already-materialized leases live out
    /// their own expiry or are revoked separately).
    pub enabled: bool,
    /// Lifetime, in seconds, stamped onto each lease this policy materializes.
    pub max_duration_secs: i64,
    pub predicates: LeasePredicates,
    pub budgets: LeaseBudgets,
    pub created_at: String,
    pub updated_at: String,
}

/// The reviewed envelope the owner settings surface submits to create or update a
/// policy. The host owns the id and timestamps; the caller supplies only the
/// authored fields. Deserialized from the renderer as camelCase.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StandingPolicyInput {
    pub label: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub max_duration_secs: i64,
    #[serde(default)]
    pub predicates: LeasePredicates,
    #[serde(default)]
    pub budgets: LeaseBudgets,
}

/// Copy a policy's budget *limits* into a fresh counter set: a materialized lease
/// always starts unused, so an edit to the policy's `callsUsed`/`spendUsedMicros`
/// (renderer noise) can never pre-charge a new lease, and each conversation gets
/// the policy's full allowance.
fn fresh_budgets(budgets: &LeaseBudgets) -> LeaseBudgets {
    LeaseBudgets {
        max_calls: budgets.max_calls,
        calls_used: 0,
        max_spend_micros: budgets.max_spend_micros,
        spend_used_micros: 0,
        asset: budgets.asset.clone(),
        // The policy's rate limit carries over, with a fresh (unopened) window
        // so each conversation gets the policy's full per-window allowance.
        max_calls_per_window: budgets.max_calls_per_window,
        window_secs: budgets.window_secs,
        window_ends_at: None,
        calls_in_window: 0,
    }
}

/// Build the lease a policy would materialize for `conversation_id`. Pure: the
/// store supplies the host-minted id, the `now` timestamp, and the pre-computed
/// `expires_at` (`now + max_duration_secs`) so lease lifetime uses the same DB
/// clock every other lease does. The lease carries the policy id so the audit
/// trail and the resolver's idempotency guard can attribute it.
pub fn candidate_lease(
    policy: &StandingPolicy,
    conversation_id: &str,
    lease_id: &str,
    now: &str,
    expires_at: &str,
) -> CapabilityLease {
    CapabilityLease {
        id: lease_id.to_string(),
        conversation_id: conversation_id.to_string(),
        label: policy.label.clone(),
        created_at: now.to_string(),
        expires_at: expires_at.to_string(),
        revoked: false,
        source_policy_id: Some(policy.id.clone()),
        predicates: policy.predicates.clone(),
        budgets: fresh_budgets(&policy.budgets),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability_lease::CommandRule;

    fn policy() -> StandingPolicy {
        StandingPolicy {
            id: "policy-1".to_string(),
            label: "Unattended coding".to_string(),
            enabled: true,
            max_duration_secs: 4 * 3600,
            predicates: LeasePredicates {
                command_rules: vec![CommandRule {
                    program: "cargo".to_string(),
                }],
                ..Default::default()
            },
            budgets: LeaseBudgets {
                max_calls: Some(200),
                calls_used: 999,
                max_spend_micros: Some(5_000_000),
                spend_used_micros: 777,
                asset: Some("USDC".to_string()),
                ..Default::default()
            },
            created_at: "2026-07-24T00:00:00Z".to_string(),
            updated_at: "2026-07-24T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn candidate_lease_starts_unused_and_is_attributed_to_the_policy() {
        let lease = candidate_lease(
            &policy(),
            "conv-a",
            "lease-1",
            "2026-07-24T00:00:00Z",
            "2026-07-24T04:00:00Z",
        );
        assert_eq!(lease.conversation_id, "conv-a");
        assert_eq!(lease.source_policy_id.as_deref(), Some("policy-1"));
        // Fresh counters regardless of any used values carried on the policy.
        assert_eq!(lease.budgets.calls_used, 0);
        assert_eq!(lease.budgets.spend_used_micros, 0);
        // Limits and predicates copy through verbatim.
        assert_eq!(lease.budgets.max_calls, Some(200));
        assert_eq!(lease.budgets.max_spend_micros, Some(5_000_000));
        assert_eq!(lease.predicates.command_rules.len(), 1);
    }

    #[test]
    fn policy_uses_the_camel_case_wire_contract() {
        let input: StandingPolicyInput = serde_json::from_value(serde_json::json!({
            "label": "Unattended coding",
            "enabled": true,
            "maxDurationSecs": 14_400,
            "predicates": { "commandRules": [{ "program": "cargo" }] },
            "budgets": { "maxCalls": 200 },
        }))
        .expect("camelCase policy input deserializes");
        assert_eq!(input.max_duration_secs, 14_400);
        assert!(input.enabled);
        assert_eq!(input.predicates.command_rules.len(), 1);

        let value = serde_json::to_value(policy()).expect("policy serializes");
        assert!(value.get("maxDurationSecs").is_some());
        assert!(value.get("enabled").is_some());
        assert!(value["predicates"].get("commandRules").is_some());
    }
}
