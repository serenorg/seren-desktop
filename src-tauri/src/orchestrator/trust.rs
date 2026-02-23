// ABOUTME: Trust graduation and satisfaction-driven model ranking.
// ABOUTME: Thompson sampling selects models based on user feedback with cost weighting.

use rand::{Rng, RngExt};
use rand_distr::Beta;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Minimum number of signals before trust can be evaluated.
const MIN_SIGNALS: u32 = 5;

/// Trust ratio threshold for FullHandoff graduation (80%).
const TRUST_THRESHOLD: f64 = 0.8;

/// Aggregated trust score for a (task_type, model_id) pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustScore {
    pub task_type: String,
    pub model_id: String,
    pub positive: u32,
    pub negative: u32,
}

impl TrustScore {
    pub fn total(&self) -> u32 {
        self.positive + self.negative
    }

    pub fn trust_level(&self) -> f64 {
        if self.total() == 0 {
            return 0.0;
        }
        self.positive as f64 / self.total() as f64
    }

    /// Whether this pair has earned FullHandoff trust.
    pub fn is_trusted(&self) -> bool {
        self.total() >= MIN_SIGNALS && self.trust_level() >= TRUST_THRESHOLD
    }
}

/// Query the trust score for a (task_type, model_id) pair from the local database.
///
/// Computes the score directly from eval_signals table aggregation.
/// Returns None if no signals exist for this pair.
pub fn get_trust_score(conn: &Connection, task_type: &str, model_id: &str) -> Option<TrustScore> {
    let result = conn
        .query_row(
            "SELECT
                COALESCE(SUM(CASE WHEN satisfaction = 1 THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN satisfaction = 0 THEN 1 ELSE 0 END), 0)
             FROM eval_signals
             WHERE task_type = ?1 AND model_id = ?2",
            rusqlite::params![task_type, model_id],
            |row| {
                Ok(TrustScore {
                    task_type: task_type.to_string(),
                    model_id: model_id.to_string(),
                    positive: row.get(0)?,
                    negative: row.get(1)?,
                })
            },
        )
        .ok()?;

    if result.total() == 0 {
        None
    } else {
        Some(result)
    }
}

/// Check if a (task_type, model_id) pair has earned full handoff trust.
pub fn is_trusted(conn: &Connection, task_type: &str, model_id: &str) -> bool {
    get_trust_score(conn, task_type, model_id)
        .map(|score| score.is_trusted())
        .unwrap_or(false)
}

// =============================================================================
// Thompson Sampling Model Ranking
// =============================================================================

/// Time-decay half-life: 30 days in milliseconds.
const DECAY_HALF_LIFE_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// Only query signals from the last 180 days.
const SIGNAL_CUTOFF_MS: i64 = 180 * 24 * 60 * 60 * 1000;

/// Model ranking produced by Thompson sampling.
#[derive(Debug, Clone)]
pub struct ModelRanking {
    pub model_id: String,
    pub score: f64,
}

/// Raw signal row from eval_signals.
struct SignalRow {
    model_id: String,
    satisfaction: i32,
    cost: Option<f64>,
    created_at: i64,
}

/// Accumulated weighted stats for a single model.
#[derive(Default)]
struct ModelStats {
    weighted_positive: f64,
    weighted_negative: f64,
    cost_sum: f64,
    cost_count: u32,
}

/// Compute Thompson sampling rankings for available models given a task type.
///
/// For each model:
/// 1. Query time-decayed positive/negative counts from eval_signals
/// 2. Sample from Beta(positive + 1, negative + 1)
/// 3. Apply cost penalty: score = sample - (cost_weight * normalized_cost)
///
/// Models with no data get Beta(1,1) = uniform random [0,1] (exploration).
/// Returns rankings sorted by score descending.
pub fn get_model_rankings<R: Rng>(
    conn: &Connection,
    rng: &mut R,
    task_type: &str,
    available_models: &[String],
    cost_weight: f64,
) -> Vec<ModelRanking> {
    if available_models.is_empty() {
        return vec![];
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let rows = query_signals(conn, task_type, available_models, now);
    let stats = accumulate_stats(&rows, now);
    sample_and_rank(rng, available_models, &stats, cost_weight)
}

/// Query eval_signals for the given task_type and models within the cutoff window.
fn query_signals(
    conn: &Connection,
    task_type: &str,
    available_models: &[String],
    now: i64,
) -> Vec<SignalRow> {
    let cutoff = now - SIGNAL_CUTOFF_MS;

    // Build parameterized IN clause
    let placeholders: Vec<String> = (0..available_models.len())
        .map(|i| format!("?{}", i + 3))
        .collect();
    let in_clause = placeholders.join(", ");

    let sql = format!(
        "SELECT model_id, satisfaction, cost, created_at
         FROM eval_signals
         WHERE task_type = ?1 AND created_at > ?2
           AND model_id IN ({in_clause})
         ORDER BY model_id"
    );

    let mut stmt = match conn.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    // Build params: task_type, cutoff, then each model_id
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    params.push(Box::new(task_type.to_string()));
    params.push(Box::new(cutoff));
    for model in available_models {
        params.push(Box::new(model.clone()));
    }

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();

    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            Ok(SignalRow {
                model_id: row.get(0)?,
                satisfaction: row.get(1)?,
                cost: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .ok();

    match rows {
        Some(iter) => iter.filter_map(|r| r.ok()).collect(),
        None => vec![],
    }
}

/// Accumulate time-decayed weighted stats per model from raw signal rows.
fn accumulate_stats(rows: &[SignalRow], now: i64) -> std::collections::HashMap<String, ModelStats> {
    let mut stats: std::collections::HashMap<String, ModelStats> = std::collections::HashMap::new();

    for row in rows {
        let age_ms = (now - row.created_at).max(0) as f64;
        let weight = (0.5_f64).powf(age_ms / DECAY_HALF_LIFE_MS);

        let entry = stats.entry(row.model_id.clone()).or_default();
        if row.satisfaction == 1 {
            entry.weighted_positive += weight;
        } else {
            entry.weighted_negative += weight;
        }

        if let Some(cost) = row.cost {
            entry.cost_sum += cost;
            entry.cost_count += 1;
        }
    }

    stats
}

/// Sample from Beta distributions and apply cost penalty to produce final rankings.
fn sample_and_rank<R: Rng>(
    rng: &mut R,
    available_models: &[String],
    stats: &std::collections::HashMap<String, ModelStats>,
    cost_weight: f64,
) -> Vec<ModelRanking> {
    // Compute max average cost across all models (for normalization)
    let max_avg_cost = stats
        .values()
        .filter_map(|s| {
            if s.cost_count > 0 {
                Some(s.cost_sum / s.cost_count as f64)
            } else {
                None
            }
        })
        .fold(0.0_f64, f64::max);

    let mut rankings: Vec<ModelRanking> = available_models
        .iter()
        .map(|model_id| {
            let (alpha, beta_param) = match stats.get(model_id) {
                Some(s) => (s.weighted_positive + 1.0, s.weighted_negative + 1.0),
                None => (1.0, 1.0), // Uniform prior for unseen models
            };

            let sample = match Beta::new(alpha, beta_param) {
                Ok(dist) => rng.sample(dist),
                Err(_) => 0.5, // Fallback if params invalid
            };

            // Cost penalty: normalized average cost * weight
            let cost_penalty = if cost_weight > 0.0 && max_avg_cost > 0.0 {
                let avg_cost = stats
                    .get(model_id)
                    .filter(|s| s.cost_count > 0)
                    .map(|s| s.cost_sum / s.cost_count as f64)
                    .unwrap_or_else(|| model_cost_tier(model_id) * max_avg_cost);

                cost_weight * (avg_cost / max_avg_cost)
            } else {
                0.0
            };

            ModelRanking {
                model_id: model_id.clone(),
                score: sample - cost_penalty,
            }
        })
        .collect();

    rankings.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rankings
}

/// Static cost tier for models without actual cost data.
/// Returns a relative cost factor in [0.0, 1.0].
fn model_cost_tier(model_id: &str) -> f64 {
    match model_id {
        m if m.contains("opus") => 1.0,
        m if m.contains("gpt-5") => 0.8,
        m if m.contains("sonnet") || m.contains("pro") => 0.5,
        m if m.contains("flash") || m.contains("haiku") || m.contains("mini") => 0.2,
        _ => 0.5,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::setup_schema;
    use rand::SeedableRng;

    fn setup_test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        setup_schema(&conn).unwrap();
        conn
    }

    fn insert_eval_signal(
        conn: &Connection,
        message_id: &str,
        task_type: &str,
        model_id: &str,
        satisfaction: i32,
    ) {
        insert_eval_signal_at(
            conn,
            message_id,
            task_type,
            model_id,
            satisfaction,
            None,
            now_ms(),
        );
    }

    fn insert_eval_signal_at(
        conn: &Connection,
        message_id: &str,
        task_type: &str,
        model_id: &str,
        satisfaction: i32,
        cost: Option<f64>,
        created_at: i64,
    ) {
        conn.execute(
            "INSERT INTO conversations (id, title, created_at) VALUES ('c1', 'Test', 1000)",
            [],
        )
        .ok();
        conn.execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, timestamp)
             VALUES (?1, 'c1', 'assistant', 'test', 1000)",
            rusqlite::params![message_id],
        )
        .ok();
        conn.execute(
            "INSERT INTO eval_signals (message_id, task_type, model_id, worker_type, satisfaction, cost, created_at, synced)
             VALUES (?1, ?2, ?3, 'chat_model', ?4, ?5, ?6, 0)",
            rusqlite::params![message_id, task_type, model_id, satisfaction, cost, created_at],
        )
        .unwrap();
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    }

    fn seeded_rng() -> rand::rngs::StdRng {
        rand::rngs::StdRng::seed_from_u64(42)
    }

    #[test]
    fn no_signals_returns_none() {
        let conn = setup_test_db();
        let score = get_trust_score(&conn, "code_generation", "claude-opus");
        assert!(score.is_none());
    }

    #[test]
    fn no_signals_not_trusted() {
        let conn = setup_test_db();
        assert!(!is_trusted(&conn, "code_generation", "claude-opus"));
    }

    #[test]
    fn below_minimum_signals_not_trusted() {
        let conn = setup_test_db();
        for i in 0..3 {
            insert_eval_signal(
                &conn,
                &format!("msg{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }

        let score = get_trust_score(&conn, "code_generation", "claude-opus").unwrap();
        assert_eq!(score.positive, 3);
        assert_eq!(score.negative, 0);
        assert_eq!(score.trust_level(), 1.0);
        assert!(!score.is_trusted()); // Below MIN_SIGNALS
    }

    #[test]
    fn five_positive_zero_negative_is_trusted() {
        let conn = setup_test_db();
        for i in 0..5 {
            insert_eval_signal(
                &conn,
                &format!("msg{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }

        let score = get_trust_score(&conn, "code_generation", "claude-opus").unwrap();
        assert_eq!(score.positive, 5);
        assert_eq!(score.negative, 0);
        assert!(score.is_trusted()); // trust = 1.0 >= 0.8, total = 5 >= 5
    }

    #[test]
    fn four_positive_one_negative_is_trusted() {
        let conn = setup_test_db();
        for i in 0..4 {
            insert_eval_signal(
                &conn,
                &format!("msg{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }
        insert_eval_signal(&conn, "msg4", "code_generation", "claude-opus", 0);

        let score = get_trust_score(&conn, "code_generation", "claude-opus").unwrap();
        assert_eq!(score.positive, 4);
        assert_eq!(score.negative, 1);
        assert_eq!(score.trust_level(), 0.8);
        assert!(score.is_trusted()); // trust = 0.8 >= 0.8
    }

    #[test]
    fn three_positive_two_negative_not_trusted() {
        let conn = setup_test_db();
        for i in 0..3 {
            insert_eval_signal(
                &conn,
                &format!("pos{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }
        for i in 0..2 {
            insert_eval_signal(
                &conn,
                &format!("neg{i}"),
                "code_generation",
                "claude-opus",
                0,
            );
        }

        let score = get_trust_score(&conn, "code_generation", "claude-opus").unwrap();
        assert_eq!(score.positive, 3);
        assert_eq!(score.negative, 2);
        assert_eq!(score.trust_level(), 0.6);
        assert!(!score.is_trusted()); // trust = 0.6 < 0.8
    }

    #[test]
    fn scores_are_scoped_to_task_type_and_model() {
        let conn = setup_test_db();
        for i in 0..5 {
            insert_eval_signal(
                &conn,
                &format!("code{i}"),
                "code_generation",
                "claude-opus",
                1,
            );
        }
        // Different task_type should have no score
        assert!(get_trust_score(&conn, "research", "claude-opus").is_none());
        // Different model should have no score
        assert!(get_trust_score(&conn, "code_generation", "gpt-4o").is_none());
        // Correct pair should be trusted
        assert!(is_trusted(&conn, "code_generation", "claude-opus"));
    }

    // =========================================================================
    // Thompson Sampling — get_model_rankings
    // =========================================================================

    #[test]
    fn ranking_returns_all_models_even_without_signals() {
        let conn = setup_test_db();
        let mut rng = seeded_rng();
        let models = vec!["model-a".to_string(), "model-b".to_string()];

        let rankings = get_model_rankings(&conn, &mut rng, "general_chat", &models, 0.1);
        assert_eq!(rankings.len(), 2);
        // Both should have scores (from Beta(1,1) uniform sampling)
        for r in &rankings {
            assert!(r.score > -1.0 && r.score <= 1.0);
        }
    }

    #[test]
    fn ranking_empty_models_returns_empty() {
        let conn = setup_test_db();
        let mut rng = seeded_rng();
        let rankings = get_model_rankings(&conn, &mut rng, "general_chat", &[], 0.1);
        assert!(rankings.is_empty());
    }

    #[test]
    fn ranking_prefers_high_satisfaction_model() {
        let conn = setup_test_db();
        let now = now_ms();

        // model-good: 20 positive, 0 negative (very strong signal)
        for i in 0..20 {
            insert_eval_signal_at(
                &conn,
                &format!("good{i}"),
                "code_generation",
                "model-good",
                1,
                None,
                now,
            );
        }

        // model-bad: 0 positive, 20 negative
        for i in 0..20 {
            insert_eval_signal_at(
                &conn,
                &format!("bad{i}"),
                "code_generation",
                "model-bad",
                0,
                None,
                now,
            );
        }

        let models = vec!["model-good".to_string(), "model-bad".to_string()];

        // Run multiple times — model-good should consistently rank first
        let mut good_first_count = 0;
        for seed in 0..20 {
            let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
            let rankings = get_model_rankings(&conn, &mut rng, "code_generation", &models, 0.0);
            if rankings[0].model_id == "model-good" {
                good_first_count += 1;
            }
        }
        // With Beta(21,1) vs Beta(1,21), the good model should win almost every time
        assert!(
            good_first_count >= 19,
            "model-good should rank first almost always, but only did {good_first_count}/20 times"
        );
    }

    #[test]
    fn ranking_applies_time_decay() {
        let conn = setup_test_db();
        let now = now_ms();

        // model-old: 10 positive signals from 90 days ago
        let old_ts = now - (90 * 24 * 60 * 60 * 1000);
        for i in 0..10 {
            insert_eval_signal_at(
                &conn,
                &format!("old{i}"),
                "general_chat",
                "model-old",
                1,
                None,
                old_ts,
            );
        }

        // model-recent: 5 positive signals from today
        for i in 0..5 {
            insert_eval_signal_at(
                &conn,
                &format!("recent{i}"),
                "general_chat",
                "model-recent",
                1,
                None,
                now,
            );
        }

        let models = vec!["model-old".to_string(), "model-recent".to_string()];

        // model-recent should usually rank higher despite fewer raw signals,
        // because its signals are recent and fully weighted
        let mut recent_first = 0;
        for seed in 0..30 {
            let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
            let rankings = get_model_rankings(&conn, &mut rng, "general_chat", &models, 0.0);
            if rankings[0].model_id == "model-recent" {
                recent_first += 1;
            }
        }
        // 90-day-old signals have weight ~0.5^3 = 0.125, so 10*0.125 = 1.25 effective positives
        // vs 5 recent positives. model-recent should win most of the time.
        assert!(
            recent_first >= 20,
            "model-recent should rank first most of the time, but only did {recent_first}/30"
        );
    }

    #[test]
    fn ranking_penalizes_expensive_model() {
        let conn = setup_test_db();
        let now = now_ms();

        // Both models have identical satisfaction (10 positive each)
        for i in 0..10 {
            insert_eval_signal_at(
                &conn,
                &format!("cheap{i}"),
                "general_chat",
                "model-cheap",
                1,
                Some(0.001),
                now,
            );
        }
        for i in 0..10 {
            insert_eval_signal_at(
                &conn,
                &format!("expensive{i}"),
                "general_chat",
                "model-expensive",
                1,
                Some(0.05),
                now,
            );
        }

        let models = vec!["model-cheap".to_string(), "model-expensive".to_string()];

        // With cost_weight=0.1, the expensive model gets a penalty
        let mut cheap_first = 0;
        for seed in 0..30 {
            let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
            let rankings = get_model_rankings(&conn, &mut rng, "general_chat", &models, 0.1);
            if rankings[0].model_id == "model-cheap" {
                cheap_first += 1;
            }
        }
        // Equal satisfaction but cheap model should win more often due to cost penalty
        assert!(
            cheap_first >= 18,
            "model-cheap should rank first most of the time, but only did {cheap_first}/30"
        );
    }

    #[test]
    fn model_cost_tier_returns_expected_values() {
        assert_eq!(model_cost_tier("anthropic/claude-opus-4-6"), 1.0);
        assert_eq!(model_cost_tier("anthropic/claude-sonnet-4"), 0.5);
        assert_eq!(model_cost_tier("anthropic/claude-haiku-4.5"), 0.2);
        assert_eq!(model_cost_tier("google/gemini-2.5-flash"), 0.2);
        assert_eq!(model_cost_tier("openai/gpt-5.3"), 0.8);
        assert_eq!(model_cost_tier("openai/gpt-4o-mini"), 0.2);
        assert_eq!(model_cost_tier("unknown/model"), 0.5);
    }
}
