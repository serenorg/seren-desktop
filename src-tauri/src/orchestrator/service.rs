// ABOUTME: Orchestrator service that ties classifier, router, and workers together.
// ABOUTME: Provides the main orchestrate() entry point called by Tauri commands.

use log;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex, mpsc, watch};
use uuid::Uuid;

use super::chat_model_worker::ChatModelWorker;
use super::classifier;
use super::cloud_agent_worker::CloudAgentWorker;
use super::decomposer;
use super::mcp_publisher_worker::McpPublisherWorker;
use super::rlm;
use super::router;
use super::subtask_context::{
    MAX_CONTEXT_SUBTASKS, MAX_SUBTASK_RESULT_BYTES, inject_dependency_results,
};
use super::tool_bridge::ToolResultBridge;
use super::trust;
use super::types::{
    DelegationType, ImageAttachment, OrchestratorEvent, RoutingDecision, SkillRef, SubTask,
    TransitionEvent, UserCapabilities, WorkerEvent, WorkerType,
};
use super::worker::Worker;
use crate::services::database::{
    DbPool, PersistedMessage, resolve_conversation_provider, save_message_record,
};

const COMMUNITY_PRIOR_TIMEOUT_MS: u64 = 200;

// =============================================================================
// Orchestrator State
// =============================================================================

/// One registered orchestration run for a conversation.
///
/// `run_token` records which `orchestrate()` call owns the entry so that a
/// stale cleanup — a run that already lost the slot — can never evict a newer
/// run's session and strand its cancel channel (see GH #3444).
struct ActiveSession {
    cancel_tx: watch::Sender<bool>,
    run_token: u64,
}

/// Managed state for the orchestrator, tracking active sessions for cancellation.
pub struct OrchestratorState {
    /// Map of conversation_id → active run (cancellation sender + ownership token).
    ///
    /// Uses a watch channel rather than a oneshot so that:
    /// - A single `send(true)` signals all consumers (forward-loop select,
    ///   retry-backoff sleep, per-iteration pre-worker check), surviving
    ///   multiple retry/reroute iterations of `execute_single_task`.
    /// - `cancel()` is idempotent: a second Stop click while the orchestrator
    ///   is still winding down is a no-op, not a misleading
    ///   "No active session" warning.
    /// - Sessions are removed only in `orchestrate()` cleanup, not on the
    ///   first cancel, so subsequent clicks during the same run find the
    ///   session and are silently absorbed.
    active_sessions: Mutex<HashMap<String, ActiveSession>>,
    /// Monotonic source of `ActiveSession::run_token` values.
    run_counter: AtomicU64,
}

impl OrchestratorState {
    pub fn new() -> Self {
        Self {
            active_sessions: Mutex::new(HashMap::new()),
            run_counter: AtomicU64::new(0),
        }
    }

    /// Register a run for `conversation_id`, returning its ownership token.
    ///
    /// Rejects when a run is already active for the conversation (GH #3444).
    /// Overwriting the entry instead would drop the first run's cancel sender
    /// — leaving it uncancellable and hot-spinning its forward loop on a
    /// closed watch channel — and the first run's cleanup would then evict
    /// the second run's entry. The frontend serializes sends per
    /// conversation, so a concurrent second call is always a bug or a race;
    /// the rejection surfaces through the `orchestrate` invoke error as the
    /// conversation's error message.
    async fn register_session(
        &self,
        conversation_id: &str,
        cancel_tx: watch::Sender<bool>,
    ) -> Result<u64, String> {
        let mut sessions = self.active_sessions.lock().await;
        if sessions.contains_key(conversation_id) {
            return Err(format!(
                "A response is already in progress for conversation {}. \
                 Stop it or wait for it to finish before sending another message.",
                conversation_id
            ));
        }
        let run_token = self.run_counter.fetch_add(1, Ordering::Relaxed);
        sessions.insert(
            conversation_id.to_string(),
            ActiveSession {
                cancel_tx,
                run_token,
            },
        );
        Ok(run_token)
    }

    /// Remove the session entry only if `run_token` still owns it.
    ///
    /// Returns whether an entry was removed. A cleanup arriving from a run
    /// that no longer owns the slot leaves the current run's entry — and its
    /// cancellability — untouched (GH #3444).
    async fn release_session(&self, conversation_id: &str, run_token: u64) -> bool {
        let mut sessions = self.active_sessions.lock().await;
        if sessions
            .get(conversation_id)
            .is_some_and(|session| session.run_token == run_token)
        {
            sessions.remove(conversation_id);
            return true;
        }
        false
    }
}

impl Default for OrchestratorState {
    fn default() -> Self {
        Self::new()
    }
}

const PRIVATE_CHAT_DEPLOYMENT_MISSING_MESSAGE: &str = "Your organization requires private chat, but no private chat deployment is configured. Please contact your organization admin.";

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn completion_message_record(
    conversation_id: &str,
    message_id: &str,
    streamed_content: &str,
    event: &WorkerEvent,
    model_id: Option<&str>,
    task_type: Option<&str>,
    started_at: i64,
    completed_at: i64,
    provider: Option<&str>,
) -> Option<PersistedMessage> {
    let WorkerEvent::Complete {
        final_content,
        cost,
        rlm_steps,
        ..
    } = event
    else {
        return None;
    };

    let content = if streamed_content.trim().is_empty() {
        final_content.as_str()
    } else {
        streamed_content
    };
    if content.trim().is_empty() {
        return None;
    }

    let mut metadata = serde_json::json!({
        "v": 1,
        "worker_type": "orchestrator",
        "model_id": model_id,
        "task_type": task_type,
        "duration": (completed_at - started_at).max(0),
        "cost": cost,
    });
    if let Some(rlm_steps) = rlm_steps.as_deref().filter(|steps| !steps.is_empty()) {
        metadata["rlm_steps"] = serde_json::Value::String(rlm_steps.to_string());
    }

    Some(PersistedMessage {
        id: message_id.to_string(),
        conversation_id: conversation_id.to_string(),
        role: "assistant".to_string(),
        content: content.to_string(),
        model: model_id.map(str::to_string),
        timestamp: completed_at,
        metadata: Some(metadata.to_string()),
        provider: provider.map(str::to_string),
    })
}

async fn persist_completion_message(app: AppHandle, mut message: PersistedMessage) {
    let message_id = message.id.clone();
    let conversation_id = message.conversation_id.clone();
    let conversation_id_for_db = conversation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if let Some(pool) = app.try_state::<DbPool>() {
            pool.with_connection(|conn| {
                if message.provider.is_none() {
                    message.provider =
                        resolve_conversation_provider(conn, &conversation_id_for_db)?;
                }
                save_message_record(conn, &message)
            })
        } else {
            let conn = crate::services::database::init_db(&app).map_err(|err| err.to_string())?;
            if message.provider.is_none() {
                message.provider = resolve_conversation_provider(&conn, &conversation_id_for_db)
                    .map_err(|err| err.to_string())?;
            }
            save_message_record(&conn, &message).map_err(|err| err.to_string())
        }
    })
    .await
    .map_err(|err| err.to_string())
    .and_then(|inner| inner);

    if let Err(err) = result {
        log::error!(
            "[Orchestrator] Failed to persist completion message {} for conversation {}: {}",
            message_id,
            conversation_id,
            err
        );
    }
}

/// Completion integrity (#3193-C, acceptance criterion: a task with an unresolved
/// required approval cannot report `completed`). Applied to the `Complete` event
/// before it is persisted or forwarded, so both the stored message and the frontend
/// see the same enforced outcome.
///
/// A worker blocks on its own linear approval (the tool call awaits the host
/// result) before it can ever emit a completion, so any approval still pending when
/// a `Complete` arrives is an orphan no continuation will resume — a settle failure
/// that stranded a pending record, not a live wait. The host therefore *settles*
/// those orphans here rather than merely disclosing them: it expires them (audited),
/// making the invariant `unresolved == 0` hold at the instant of completion, and
/// broadcasts the now-cleared task state on the real worker path so the thread
/// status converges at once instead of at the next renderer poll. The final summary
/// discloses the lapsed, un-performed work.
///
/// The host never hard-blocks the completion event: there is no terminal
/// "not-completed" worker event, so suppressing `Complete` would leave the turn with
/// no terminal frame — the exact hung-agent symptom this ticket exists to prevent.
/// A store error or a missing state leaves the event untouched (fail-open on the
/// disclosure, never on the completion itself).
fn guard_completion<R: tauri::Runtime>(
    app: &AppHandle<R>,
    conversation_id: &str,
    event: WorkerEvent,
) -> WorkerEvent {
    let WorkerEvent::Complete {
        final_content,
        thinking,
        cost,
        rlm_steps,
    } = event
    else {
        return event;
    };
    let notice = app
        .try_state::<crate::tool_authorization::ToolAuthorizationState>()
        .and_then(|state| {
            match state.settle_conversation_on_completion(conversation_id) {
                Ok(settlement) => {
                    if settlement.newly_expired > 0 {
                        log::warn!(
                            "[Orchestrator] Task {conversation_id} reached completion with {} approval(s) still pending; expired and disclosed",
                            settlement.newly_expired
                        );
                        // Host-owned transition on the real completion path: the
                        // pending block is gone, so broadcast the cleared task state
                        // now rather than waiting for the renderer's poll.
                        crate::commands::tool_authorization::emit_task_execution_state(
                            app,
                            state.inner(),
                            conversation_id,
                        );
                    }
                    settlement.completion_notice()
                }
                Err(err) => {
                    log::warn!(
                        "[Orchestrator] Completion-integrity settle failed for {conversation_id}: {err}"
                    );
                    None
                }
            }
        });
    let final_content = match notice {
        Some(note) => format!("{final_content}{note}"),
        None => final_content,
    };
    WorkerEvent::Complete {
        final_content,
        thinking,
        cost,
        rlm_steps,
    }
}

/// Sleep for `duration`, returning early if the cancel flag flips to true.
///
/// Returns `true` if the sleep completed normally, `false` if cancelled.
/// Used to keep retry backoffs responsive to Stop clicks (see GH #1581).
async fn sleep_or_cancel(
    duration: std::time::Duration,
    cancel_rx: &mut watch::Receiver<bool>,
) -> bool {
    if *cancel_rx.borrow() {
        return false;
    }
    tokio::select! {
        _ = tokio::time::sleep(duration) => true,
        _ = cancel_rx.changed() => !*cancel_rx.borrow(),
    }
}

/// Bound on how long Stop waits for a worker's `cancel()` before falling back
/// to aborting its task. A wedged runtime can accept the cancel connection and
/// never reply; without a bound `orchestrate()` never reaches session cleanup
/// and the conversation stays "running" until app restart (see GH #3433).
const WORKER_CANCEL_TIMEOUT: Duration = Duration::from_secs(5);

/// Await `worker.cancel()` for at most `timeout`.
///
/// Returns `true` if the cancel resolved in time, `false` on timeout. Callers
/// proceed to abort the worker task either way — abort handles teardown — so a
/// hung cancel can delay Stop by at most `timeout` (see GH #3433).
async fn cancel_worker_or_timeout(worker: &dyn Worker, timeout: Duration) -> bool {
    if tokio::time::timeout(timeout, worker.cancel()).await.is_err() {
        log::warn!(
            "[Orchestrator] Worker '{}' cancel did not resolve within {:?}; proceeding to abort",
            worker.id(),
            timeout
        );
        return false;
    }
    true
}

/// Cancel and abort every worker already spawned in the current layer.
///
/// Used when spawning a layer fails partway (GH #3445): without this, the
/// workers spawned before the failure keep executing — and spending — with no
/// supervisor. Bounded per-worker cancel (GH #3433) followed by task abort
/// mirrors the Stop path.
async fn abort_layer<T>(workers: &[Arc<dyn Worker>], handles: &[tokio::task::JoinHandle<T>]) {
    for worker in workers {
        cancel_worker_or_timeout(worker.as_ref(), WORKER_CANCEL_TIMEOUT).await;
    }
    for handle in handles {
        handle.abort();
    }
}

/// Set the terminal status on an orchestration plan row.
///
/// Shared by the normal completion path and the mid-layer failure path
/// (GH #3445) so a plan can never be left `'active'` forever; extracted so
/// the SQL is testable without an `AppHandle`.
fn finalize_plan_row(
    conn: &rusqlite::Connection,
    plan_id: &str,
    status: &str,
    completed_at: i64,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE orchestration_plans SET status = ?1, completed_at = ?2 WHERE id = ?3",
        rusqlite::params![status, completed_at, plan_id],
    )
}

/// Persist a plan's terminal status. Best-effort: a database failure is not
/// allowed to mask the orchestration outcome being returned to the caller.
async fn finalize_plan(app: &AppHandle, plan_id: &str, status: &str) {
    let app = app.clone();
    let plan_id = plan_id.to_string();
    let status = status.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(conn) = crate::services::database::init_db(&app) {
            let _ = finalize_plan_row(&conn, &plan_id, &status, now_millis());
        }
    })
    .await
    .ok();
}

// =============================================================================
// Model Fallback Chain
// =============================================================================

/// Returns the next faster model in the fallback chain for 408 timeout errors.
/// Opus → Sonnet → Haiku → None
fn get_fallback_model(current_model: &str) -> Option<&str> {
    match current_model {
        // Opus variants fallback to Sonnet
        "anthropic/claude-opus-4" | "anthropic/claude-opus-4.5" | "anthropic/claude-opus-4.6" => {
            Some("anthropic/claude-sonnet-4.5")
        }
        // Sonnet variants fallback to Haiku
        "anthropic/claude-sonnet-4" | "anthropic/claude-sonnet-4.5" => {
            Some("anthropic/claude-haiku-4.5")
        }
        // Haiku has no faster fallback
        _ => None,
    }
}

async fn get_rankings_for_task(
    app: &AppHandle,
    task_type: &str,
    available_models: &[String],
    cost_weight: f64,
) -> Vec<trust::ModelRanking> {
    if available_models.is_empty() {
        return vec![];
    }

    let app_for_db = app.clone();
    let task_type_for_db = task_type.to_string();
    let models_for_db = available_models.to_vec();
    let models_for_fetch = available_models.to_vec();
    let task_type_for_fetch = task_type.to_string();

    let local_stats = tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::services::database::init_db(&app_for_db).ok()?;
        Some(trust::load_model_stats(
            &conn,
            &task_type_for_db,
            &models_for_db,
        ))
    });

    let community_priors =
        fetch_community_priors_for_rankings(app.clone(), task_type_for_fetch, models_for_fetch);
    let (stats_result, community_priors) = tokio::join!(local_stats, community_priors);
    let stats = match stats_result {
        Ok(Some(stats)) => stats,
        _ => return vec![],
    };

    if !community_priors.is_empty() {
        log::debug!(
            "[Orchestrator] Applying {} community prior(s) for task_type={}",
            community_priors.len(),
            task_type
        );
    }

    let mut rng = rand::rng();
    let community_priors = if community_priors.is_empty() {
        None
    } else {
        Some(&community_priors)
    };
    trust::sample_model_rankings(
        &mut rng,
        available_models,
        &stats,
        community_priors,
        cost_weight,
    )
}

async fn fetch_community_priors_for_rankings(
    app: AppHandle,
    task_type: String,
    available_models: Vec<String>,
) -> HashMap<String, super::eval::CommunityPrior> {
    let token = match crate::auth::get_access_token(&app) {
        Ok(token) => token,
        Err(err) => {
            log::debug!(
                "[Orchestrator] Skipping community prior fetch for task_type={}: {}",
                task_type,
                err
            );
            return HashMap::new();
        }
    };

    super::eval::fetch_community_priors(
        &token,
        &task_type,
        &available_models,
        Duration::from_millis(COMMUNITY_PRIOR_TIMEOUT_MS),
    )
    .await
}

// =============================================================================
// Main Orchestration Flow
// =============================================================================

/// Execute the full orchestration pipeline for a user prompt.
///
/// 1. Classify the task
/// 2. Decompose into subtasks
/// 3. Single subtask → fast path (route, trust, execute)
/// 4. Multiple subtasks → parallel execution by dependency layers
pub async fn orchestrate(
    app: AppHandle,
    state: &OrchestratorState,
    conversation_id: String,
    assistant_message_id: String,
    prompt: String,
    history: Vec<serde_json::Value>,
    capabilities: UserCapabilities,
    images: Vec<ImageAttachment>,
) -> Result<(), String> {
    log::info!(
        "[Orchestrator] Starting orchestration for conversation {}",
        conversation_id
    );
    let started_at_ms = now_millis();

    // 0. RLM check: if input exceeds context window threshold, process recursively.
    //    Use the user-selected model (or a sensible default) for the limit check.
    let model_for_limit = capabilities
        .selected_model
        .as_deref()
        .filter(|m| !m.is_empty())
        .unwrap_or("anthropic/claude-sonnet-4");

    if rlm::needs_rlm(&prompt, &history, &images, model_for_limit) {
        // When the org forces private chat, RLM would route through a public model,
        // violating the policy. Return a clear error rather than silently bypassing it.
        if capabilities.force_private_chat {
            log::warn!(
                "[Orchestrator] force_private_chat is enabled but message exceeds context limit — rejecting"
            );
            let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<WorkerEvent>(4);
            let app_clone = app.clone();
            let _ = event_tx
                .send(WorkerEvent::Error {
                    message: "This message is too large for your organization's private chat \
                              deployment. Please shorten your message or start a new conversation."
                        .to_string(),
                })
                .await;
            drop(event_tx);
            while let Some(event) = event_rx.recv().await {
                let orch_event = OrchestratorEvent {
                    conversation_id: conversation_id.clone(),
                    worker_event: event,
                    subtask_id: None,
                };
                let _ = app_clone.emit("orchestrator://event", &orch_event);
            }
            return Ok(());
        }

        log::info!("[Orchestrator] Input exceeds context threshold — activating RLM");

        // Create an event channel and forward events to the frontend.
        let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<WorkerEvent>(64);
        let app_clone = app.clone();
        let assistant_message_id_for_rlm = assistant_message_id.clone();
        let started_at_for_rlm = started_at_ms;
        let conv_id = conversation_id.clone();

        // Spawn the RLM processor
        let rlm_model = model_for_limit.to_string();
        let rlm_model_for_persistence = rlm_model.clone();
        let rlm_prompt = prompt.clone();
        let rlm_history = history.clone();
        let rlm_tools = capabilities.tool_definitions.clone();
        let rlm_app = app.clone();
        tokio::spawn(async move {
            if let Err(e) = rlm::process(
                &rlm_app,
                &conv_id,
                &rlm_prompt,
                &rlm_history,
                &rlm_model,
                &rlm_tools,
                &event_tx,
            )
            .await
            {
                let _ = event_tx.send(WorkerEvent::Error { message: e }).await;
            }
        });

        // Forward all events to the frontend
        let mut streamed_content = String::new();
        while let Some(event) = event_rx.recv().await {
            if let WorkerEvent::Content { text } = &event {
                streamed_content.push_str(text);
            }
            let event = guard_completion(&app_clone, &conversation_id, event);
            if matches!(event, WorkerEvent::Complete { .. }) {
                if let Some(record) = completion_message_record(
                    &conversation_id,
                    &assistant_message_id_for_rlm,
                    &streamed_content,
                    &event,
                    Some(&rlm_model_for_persistence),
                    None,
                    started_at_for_rlm,
                    now_millis(),
                    None,
                ) {
                    persist_completion_message(app_clone.clone(), record).await;
                }
            }
            let orch_event = OrchestratorEvent {
                conversation_id: conversation_id.clone(),
                worker_event: event,
                subtask_id: None,
            };
            let _ = app_clone.emit("orchestrator://event", &orch_event);
        }

        return Ok(());
    }

    // 0b. Trim history if it exceeds the context budget. This prevents the
    //     case where large history (e.g. from prior failed attempts) would cause
    //     an oversized request to the model.
    let history = rlm::trim_history(&history, &prompt, &images, model_for_limit);

    // 1. Classify the task
    let classification = classifier::classify(&prompt, &capabilities.installed_skills);
    log::info!(
        "[Orchestrator] Classification: type={}, complexity={:?}",
        classification.task_type,
        classification.complexity
    );

    // 2. Decompose into subtasks
    let subtasks = decomposer::decompose(&prompt, &classification, &capabilities.installed_skills);
    log::info!(
        "[Orchestrator] Decomposed into {} subtask(s)",
        subtasks.len()
    );

    // 3. Register cancellation. A watch channel lets the cancel flag be
    //    observed by every retry iteration and every cancellable sleep; a
    //    oneshot would be consumed by the first observer and leave later
    //    iterations uncancellable (see GH #1581). Registration rejects a
    //    concurrent run for the same conversation (see GH #3444).
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let run_token = state.register_session(&conversation_id, cancel_tx).await?;

    // 4. Branch: single task (fast path) vs multi-task (parallel execution)
    let result = if subtasks.len() <= 1 {
        execute_single_task(
            &app,
            &conversation_id,
            &subtasks[0],
            &history,
            &capabilities,
            &images,
            cancel_rx,
            &assistant_message_id,
            started_at_ms,
        )
        .await
    } else {
        execute_multi_task(
            &app,
            &conversation_id,
            &prompt,
            subtasks,
            &history,
            &capabilities,
            &images,
            cancel_rx,
            &assistant_message_id,
            started_at_ms,
        )
        .await
    };

    // 5. Clean up session — only if this run still owns the entry, so a
    //    stale cleanup can never evict a newer run's session (GH #3444).
    state.release_session(&conversation_id, run_token).await;

    // Drop any frontend tool-call bridge entries this conversation still has
    // pending. A worker aborted by Stop leaves its entry behind (nothing else
    // removes it until the next main-view reload), and a still-running
    // detached worker awaiting one of these observes the drop as a closed
    // channel and finishes with "Tool execution was cancelled" (GH #3446).
    if let Some(bridge) = app.try_state::<ToolResultBridge>() {
        let purged = bridge.remove_for_conversation(&conversation_id).await;
        if purged > 0 {
            log::info!(
                "[Orchestrator] Purged {} pending frontend tool call(s) for conversation {}",
                purged,
                conversation_id
            );
        }
    }

    result
}

// =============================================================================
// Single-Task Execution (Fast Path)
// =============================================================================

/// Execute a single subtask with automatic reroute on transient errors.
///
/// When a worker hits a 408/429/5xx, the orchestrator queries eval_signals
/// for satisfaction-ranked fallback models and retries with a different model.
/// Respects user-selected models (no reroute when user explicitly chose a model).
async fn execute_single_task(
    app: &AppHandle,
    conversation_id: &str,
    subtask: &SubTask,
    history: &[serde_json::Value],
    capabilities: &UserCapabilities,
    images: &[ImageAttachment],
    cancel_rx: watch::Receiver<bool>,
    assistant_message_id: &str,
    started_at_ms: i64,
) -> Result<(), String> {
    // Compute Thompson sampling rankings before routing
    let mut capabilities = capabilities.clone();
    let rankings = get_rankings_for_task(
        app,
        &subtask.classification.task_type,
        &capabilities.available_models,
        0.1,
    )
    .await;

    capabilities.model_rankings = rankings
        .iter()
        .map(|r| (r.model_id.clone(), r.score))
        .collect();

    let user_explicitly_selected = capabilities
        .selected_model
        .as_ref()
        .is_some_and(|m| !m.is_empty());

    // Route with rankings-enriched capabilities
    let mut routing = router::route(&subtask.classification, &capabilities, &subtask.prompt);

    // Trust graduation
    let app_for_trust = app.clone();
    let task_type = subtask.classification.task_type.clone();
    let model_id = routing.model_id.clone();
    let trusted = tauri::async_runtime::spawn_blocking(move || {
        match crate::services::database::init_db(&app_for_trust) {
            Ok(conn) => trust::is_trusted(&conn, &task_type, &model_id),
            Err(_) => false,
        }
    })
    .await
    .unwrap_or(false);

    if trusted {
        routing.delegation = DelegationType::FullHandoff;
        routing.reason = format!("{} (trusted)", routing.reason);
    }

    // Track tried models for reroute
    let mut tried_models: Vec<String> = vec![routing.model_id.clone()];
    let mut reroute_count: usize = 0;
    let mut same_model_retry_count: usize = 0;
    const MAX_SAME_MODEL_RETRIES: usize = 1;
    let mut network_retry_count: usize = 0;

    loop {
        // Bail out if cancellation arrived between iterations (e.g. during
        // the previous worker's unwind or a backoff that already exited).
        if *cancel_rx.borrow() {
            log::info!(
                "[Orchestrator] Cancellation observed at top of retry loop for {}",
                conversation_id
            );
            break;
        }

        // Load skills
        let skill_content = load_skill_content(&routing.selected_skills)?;

        // Emit transition
        let transition = TransitionEvent {
            conversation_id: conversation_id.to_string(),
            model_name: routing.model_id.clone(),
            task_description: routing.reason.clone(),
        };
        app.emit("orchestrator://transition", &transition)
            .map_err(|e| format!("Failed to emit transition event: {}", e))?;

        // Create channel and spawn worker
        let (event_tx, mut event_rx) = mpsc::channel::<WorkerEvent>(256);
        let worker = create_worker(&routing, app, &capabilities)?;
        let worker_for_cancel = Arc::clone(&worker);
        let worker_prompt = subtask.prompt.clone();
        let worker_routing = routing.clone();
        let worker_app = app.clone();
        let worker_images = images.to_vec();
        let worker_history = history.to_vec();
        let worker_conversation_id = conversation_id.to_string();
        let worker_handle = tokio::spawn(async move {
            worker
                .execute(
                    &worker_conversation_id,
                    &worker_prompt,
                    &worker_history,
                    &worker_routing,
                    &skill_content,
                    &worker_app,
                    &worker_images,
                    event_tx,
                )
                .await
        });

        // Collect events, looking for reroutable errors.
        // A fresh watch::Receiver clone per iteration keeps cancellation
        // observable across retry/reroute rounds (the receiver is never
        // consumed — unlike a oneshot).
        let conv_id = conversation_id.to_string();
        let app_for_events = app.clone();
        let assistant_message_id_for_events = assistant_message_id.to_string();
        let model_id_for_events = routing.model_id.clone();
        let task_type_for_events = subtask.classification.task_type.clone();
        let started_at_for_events = started_at_ms;
        let mut cancel_rx_forward = cancel_rx.clone();

        // Returns (was_cancelled, captured_error).
        let mut reroutable_error: Option<String> = None;
        let forward_handle = tokio::spawn(async move {
            let mut captured_error: Option<String> = None;
            let mut cancelled = *cancel_rx_forward.borrow();
            let mut streamed_content = String::new();
            while !cancelled {
                tokio::select! {
                    event = event_rx.recv() => {
                        match event {
                            Some(worker_event) => {
                                if let WorkerEvent::Content { text } = &worker_event {
                                    streamed_content.push_str(text);
                                }
                                if let WorkerEvent::Error { ref message } = worker_event {
                                    captured_error = Some(message.clone());
                                }
                                let worker_event =
                                    guard_completion(&app_for_events, &conv_id, worker_event);
                                if matches!(worker_event, WorkerEvent::Complete { .. }) {
                                    if let Some(record) = completion_message_record(
                                        &conv_id,
                                        &assistant_message_id_for_events,
                                        &streamed_content,
                                        &worker_event,
                                        Some(&model_id_for_events),
                                        Some(&task_type_for_events),
                                        started_at_for_events,
                                        now_millis(),
                                        None,
                                    ) {
                                        persist_completion_message(app_for_events.clone(), record).await;
                                    }
                                }
                                let orchestrator_event = OrchestratorEvent {
                                    conversation_id: conv_id.clone(),
                                    worker_event,
                                    subtask_id: None,
                                };
                                if let Err(e) = app_for_events.emit("orchestrator://event", &orchestrator_event) {
                                    log::error!("[Orchestrator] Failed to emit event: {}", e);
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                    _ = cancel_rx_forward.changed() => {
                        if *cancel_rx_forward.borrow() {
                            log::info!("[Orchestrator] Cancellation received for conversation {}", conv_id);
                            cancelled = true;
                        }
                    }
                }
            }
            (cancelled, captured_error)
        });

        let forward_result = forward_handle.await;
        let was_cancelled = forward_result.as_ref().map(|(c, _)| *c).unwrap_or(false);
        if let Ok((_, Some(ref error_msg))) = forward_result {
            reroutable_error = Some(error_msg.clone());
        }

        // If the forward loop exited due to cancellation, signal the worker
        // to stop and abort its task so in-flight HTTP requests don't linger.
        if was_cancelled {
            log::info!(
                "[Orchestrator] Cancelling worker for conversation {}",
                conversation_id
            );
            cancel_worker_or_timeout(worker_for_cancel.as_ref(), WORKER_CANCEL_TIMEOUT).await;
            worker_handle.abort();
            break;
        }

        match worker_handle.await {
            Ok(Ok(())) => {
                log::info!(
                    "[Orchestrator] Completed single-task orchestration for conversation {}",
                    conversation_id
                );
            }
            Ok(Err(e)) => {
                log::error!("[Orchestrator] Worker error: {}", e);
                if reroutable_error.is_none() {
                    let error_message = e;
                    let error_event = OrchestratorEvent {
                        conversation_id: conversation_id.to_string(),
                        worker_event: WorkerEvent::Error {
                            message: error_message.clone(),
                        },
                        subtask_id: None,
                    };
                    let _ = app.emit("orchestrator://event", &error_event);
                    reroutable_error = Some(error_message);
                }
            }
            Err(e) => {
                log::error!("[Orchestrator] Worker task panicked: {}", e);
                let error_message = "Internal error: worker task failed".to_string();
                let error_event = OrchestratorEvent {
                    conversation_id: conversation_id.to_string(),
                    worker_event: WorkerEvent::Error {
                        message: error_message.clone(),
                    },
                    subtask_id: None,
                };
                let _ = app.emit("orchestrator://event", &error_event);
                reroutable_error = Some(error_message);
            }
        }

        // Network transport errors (connection refused, DNS, etc.) should be
        // retried on the same model with exponential backoff — rerouting to a
        // different model won't help since all models share the same gateway.
        let is_network_error = reroutable_error
            .as_ref()
            .is_some_and(|msg| router::is_network_transport_error(msg));

        if is_network_error {
            network_retry_count += 1;
            if network_retry_count <= router::MAX_NETWORK_RETRIES {
                let backoff_secs = 2u64.pow(network_retry_count as u32); // 2, 4, 8, 16, 32
                log::warn!(
                    "[Orchestrator] Network error (attempt {}/{}), retrying in {}s: {}",
                    network_retry_count,
                    router::MAX_NETWORK_RETRIES,
                    backoff_secs,
                    reroutable_error.as_deref().unwrap_or("unknown"),
                );
                let mut cancel_sleep = cancel_rx.clone();
                if !sleep_or_cancel(
                    std::time::Duration::from_secs(backoff_secs),
                    &mut cancel_sleep,
                )
                .await
                {
                    log::info!(
                        "[Orchestrator] Cancellation received during network backoff for {}",
                        conversation_id
                    );
                    break;
                }
                continue;
            }
            log::error!(
                "[Orchestrator] Network error persists after {} retries, giving up: {}",
                router::MAX_NETWORK_RETRIES,
                reroutable_error.as_deref().unwrap_or("unknown"),
            );
            return Err(
                reroutable_error.unwrap_or_else(|| "Network request failed".to_string()),
            );
        }

        // Reset network retry counter on non-network outcomes (success or other errors)
        network_retry_count = 0;

        // Check if we got a transient error eligible for retry/reroute
        let is_transient = reroutable_error
            .as_ref()
            .is_some_and(|msg| router::is_reroutable_error(msg));

        if !is_transient {
            if let Some(error_message) = reroutable_error {
                return Err(error_message);
            }
            break;
        }

        let error_msg = reroutable_error.unwrap();

        // Context-overflow errors get special handling: reroute to a 1M-context
        // model regardless of whether the user explicitly selected a model.
        if router::is_context_overflow_error(&error_msg) {
            if let Some(fallback_model_str) = router::get_large_context_fallback(&tried_models) {
                let failed_model = routing.model_id.clone();
                let fallback_model = fallback_model_str.to_string();

                log::info!(
                    "[Orchestrator] Context overflow on {}, falling back to large-context model: {}",
                    failed_model,
                    fallback_model
                );

                let reroute_event = OrchestratorEvent {
                    conversation_id: conversation_id.to_string(),
                    worker_event: WorkerEvent::Reroute {
                        from_model: failed_model.clone(),
                        to_model: fallback_model.clone(),
                        reason:
                            "Switched to larger context model — conversation exceeded model limit"
                                .to_string(),
                    },
                    subtask_id: None,
                };
                let _ = app.emit("orchestrator://event", &reroute_event);

                routing.model_id = fallback_model.clone();
                tried_models.push(fallback_model);

                let mut cancel_sleep = cancel_rx.clone();
                if !sleep_or_cancel(std::time::Duration::from_secs(1), &mut cancel_sleep).await {
                    log::info!(
                        "[Orchestrator] Cancellation received during context-overflow reroute for {}",
                        conversation_id
                    );
                    break;
                }
                continue;
            }
            // All large-context models exhausted — fall through to give up
            log::warn!("[Orchestrator] Context overflow but all large-context fallbacks exhausted");
            return Err(error_msg);
        }

        // When user explicitly selected a model, try cascading fallback on timeout errors.
        // For 408 timeouts: Opus → Sonnet → Haiku, then retry same model once before giving up.
        if user_explicitly_selected {
            // Check if this is a 408 timeout error that's eligible for model fallback
            let is_timeout_error =
                error_msg.contains("408") || error_msg.contains("Request Timeout");

            // Try cascading to a faster model on timeout (Opus→Sonnet→Haiku)
            if is_timeout_error {
                if let Some(fallback_model_str) = get_fallback_model(&routing.model_id) {
                    let failed_model = routing.model_id.clone();
                    let fallback_model = fallback_model_str.to_string(); // Convert to owned String

                    log::info!(
                        "[Orchestrator] 408 timeout on {}, falling back to faster model: {}",
                        failed_model,
                        fallback_model
                    );

                    // Emit reroute event to notify frontend
                    let reroute_event = OrchestratorEvent {
                        conversation_id: conversation_id.to_string(),
                        worker_event: WorkerEvent::Reroute {
                            from_model: failed_model.clone(),
                            to_model: fallback_model.clone(),
                            reason: "Switched to faster model due to timeout".to_string(),
                        },
                        subtask_id: None,
                    };
                    let _ = app.emit("orchestrator://event", &reroute_event);

                    // Update routing to use fallback model
                    routing.model_id = fallback_model.clone();
                    tried_models.push(fallback_model);

                    // Brief backoff before retry with new model
                    let mut cancel_sleep = cancel_rx.clone();
                    if !sleep_or_cancel(std::time::Duration::from_secs(2), &mut cancel_sleep).await
                    {
                        log::info!(
                            "[Orchestrator] Cancellation received during timeout fallback for {}",
                            conversation_id
                        );
                        break;
                    }
                    continue;
                }
            }

            // No faster model available, or non-timeout error: retry same model once
            if same_model_retry_count >= MAX_SAME_MODEL_RETRIES {
                log::warn!(
                    "[Orchestrator] Transient error on explicitly-selected model {} after {} retry, giving up: {}",
                    routing.model_id,
                    same_model_retry_count,
                    error_msg,
                );
                return Err(error_msg);
            }

            same_model_retry_count += 1;
            log::info!(
                "[Orchestrator] Retrying explicitly-selected model {} (attempt {}/{}): {}",
                routing.model_id,
                same_model_retry_count,
                MAX_SAME_MODEL_RETRIES,
                error_msg,
            );

            // Brief backoff before retry
            let mut cancel_sleep = cancel_rx.clone();
            if !sleep_or_cancel(std::time::Duration::from_secs(2), &mut cancel_sleep).await {
                log::info!(
                    "[Orchestrator] Cancellation received during same-model retry backoff for {}",
                    conversation_id
                );
                break;
            }
            continue;
        }

        // Auto-selected model: reroute to a different model
        if reroute_count >= router::MAX_REROUTE_ATTEMPTS {
            log::warn!(
                "[Orchestrator] Giving up after {} reroute attempts",
                reroute_count
            );
            return Err(error_msg);
        }

        let failed_model = routing.model_id.clone();
        log::info!(
            "[Orchestrator] Attempting reroute #{} after error on {}: {}",
            reroute_count + 1,
            failed_model,
            error_msg
        );

        // Query satisfaction-ranked fallback from database
        let app_for_reroute = app.clone();
        let task_type_for_reroute = subtask.classification.task_type.clone();
        let tried_for_reroute = tried_models.clone();
        let available_for_reroute = capabilities.available_models.clone();
        let classification_for_reroute = subtask.classification.clone();

        let reroute_result =
            tauri::async_runtime::spawn_blocking(move || match crate::services::database::init_db(
                &app_for_reroute,
            ) {
                Ok(conn) => router::reroute_on_failure(
                    &conn,
                    &task_type_for_reroute,
                    &tried_for_reroute,
                    &available_for_reroute,
                    &classification_for_reroute,
                ),
                Err(_) => None,
            })
            .await
            .unwrap_or(None);

        match reroute_result {
            Some((new_model, reason)) => {
                // Emit reroute event to frontend
                let reroute_event = OrchestratorEvent {
                    conversation_id: conversation_id.to_string(),
                    worker_event: WorkerEvent::Reroute {
                        from_model: failed_model.clone(),
                        to_model: new_model.clone(),
                        reason: reason.clone(),
                    },
                    subtask_id: None,
                };
                let _ = app.emit("orchestrator://event", &reroute_event);

                // Update routing for next iteration
                routing.model_id = new_model.clone();
                routing.reason = reason;
                tried_models.push(new_model);
                reroute_count += 1;

                log::info!(
                    "[Orchestrator] Rerouting from {} to {} (attempt {})",
                    failed_model,
                    routing.model_id,
                    reroute_count,
                );
            }
            None => {
                log::warn!(
                    "[Orchestrator] No fallback model available, giving up after {} reroute attempts",
                    reroute_count
                );
                return Err(error_msg);
            }
        }
    }

    Ok(())
}

// =============================================================================
// Multi-Task Execution (Parallel by Dependency Layers)
// =============================================================================

/// Execute multiple subtasks grouped by dependency layers.
///
/// Layer 0 tasks run in parallel, then layer 1, etc.
/// All worker events are forwarded through a shared channel with subtask_id tagging.
/// Plan is persisted to SQLite for resumability.
async fn execute_multi_task(
    app: &AppHandle,
    conversation_id: &str,
    original_prompt: &str,
    subtasks: Vec<SubTask>,
    history: &[serde_json::Value],
    capabilities: &UserCapabilities,
    images: &[ImageAttachment],
    cancel_watch_rx: watch::Receiver<bool>,
    assistant_message_id: &str,
    started_at_ms: i64,
) -> Result<(), String> {
    // Persist plan to SQLite
    let plan_id = Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let app_for_db = app.clone();
    let plan_id_for_db = plan_id.clone();
    let conv_id_for_db = conversation_id.to_string();
    let prompt_for_db = original_prompt.to_string();
    let subtasks_for_db: Vec<(String, String, String)> = subtasks
        .iter()
        .map(|st| {
            let routing = router::route(&st.classification, capabilities, &st.prompt);
            (st.id.clone(), st.prompt.clone(), routing.model_id.clone())
        })
        .collect();
    let subtask_meta: Vec<(String, String, String, String)> = subtasks
        .iter()
        .map(|st| {
            let routing = router::route(&st.classification, capabilities, &st.prompt);
            (
                st.id.clone(),
                st.classification.task_type.clone(),
                format!("{:?}", routing.worker_type),
                serde_json::to_string(&st.depends_on).unwrap_or_default(),
            )
        })
        .collect();

    let db_now = now;
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(conn) = crate::services::database::init_db(&app_for_db) {
            let _ = conn.execute(
                "INSERT INTO orchestration_plans (id, conversation_id, original_prompt, status, created_at) VALUES (?1, ?2, ?3, 'active', ?4)",
                rusqlite::params![plan_id_for_db, conv_id_for_db, prompt_for_db, db_now],
            );

            for (i, (id, prompt, _model)) in subtasks_for_db.iter().enumerate() {
                let (_, task_type, worker_type, depends_on) = &subtask_meta[i];
                let model_id = &subtasks_for_db[i].2;
                let deps = if depends_on == "[]" {
                    None
                } else {
                    Some(depends_on.as_str())
                };
                let _ = conn.execute(
                    "INSERT INTO plan_subtasks (id, plan_id, prompt, task_type, worker_type, model_id, status, depends_on, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8)",
                    rusqlite::params![id, plan_id_for_db, prompt, task_type, worker_type, model_id, deps, db_now],
                );
            }
        }
    })
    .await
    .ok();

    log::info!(
        "[Orchestrator] Persisted plan {} with {} subtasks",
        plan_id,
        subtasks.len()
    );

    // Shared event channel: all workers send (subtask_id, event) through this
    let (shared_tx, mut shared_rx) = mpsc::channel::<(String, WorkerEvent)>(256);

    // Spawn event forwarding task
    let conv_id = conversation_id.to_string();
    let app_for_events = app.clone();
    let assistant_message_id_for_events = assistant_message_id.to_string();
    let started_at_for_events = started_at_ms;
    let mut cancel_watch_for_forward = cancel_watch_rx.clone();
    let forward_handle = tokio::spawn(async move {
        let mut streamed_by_subtask: HashMap<String, String> = HashMap::new();
        loop {
            tokio::select! {
                event = shared_rx.recv() => {
                    match event {
                        Some((subtask_id, worker_event)) => {
                            if let WorkerEvent::Content { text } = &worker_event {
                                streamed_by_subtask
                                    .entry(subtask_id.clone())
                                    .or_default()
                                    .push_str(text);
                            }
                            // Settle any approval the host suspended for this
                            // conversation and append the same disclosure notice
                            // the single-task path adds before the subtask's
                            // completion is persisted and forwarded. Without this a
                            // decomposed subtask completes with an approval still
                            // pending, leaving the thread stuck on "waiting for
                            // approval" until the continuation's TTL or a reload.
                            let worker_event =
                                guard_completion(&app_for_events, &conv_id, worker_event);
                            if matches!(worker_event, WorkerEvent::Complete { .. }) {
                                let message_id = format!("{}:{}", assistant_message_id_for_events, subtask_id);
                                let streamed_content = streamed_by_subtask
                                    .get(&subtask_id)
                                    .map(String::as_str)
                                    .unwrap_or_default();
                                if let Some(record) = completion_message_record(
                                    &conv_id,
                                    &message_id,
                                    streamed_content,
                                    &worker_event,
                                    None,
                                    None,
                                    started_at_for_events,
                                    now_millis(),
                                    None,
                                ) {
                                    persist_completion_message(app_for_events.clone(), record).await;
                                }
                            }
                            let orchestrator_event = OrchestratorEvent {
                                conversation_id: conv_id.clone(),
                                worker_event,
                                subtask_id: Some(subtask_id),
                            };
                            if let Err(e) = app_for_events.emit("orchestrator://event", &orchestrator_event) {
                                log::error!("[Orchestrator] Failed to emit event: {}", e);
                                break;
                            }
                        }
                        None => break,
                    }
                }
                changed = cancel_watch_for_forward.changed() => {
                    if changed.is_ok() && *cancel_watch_for_forward.borrow() {
                        log::info!("[Orchestrator] Cancellation received for multi-task conversation {}", conv_id);
                        break;
                    }
                }
            }
        }
    });

    // Execute subtasks layer by layer
    let layers = decomposer::dependency_layers(&subtasks);
    let mut consecutive_failures: u32 = 0;
    const MAX_CONSECUTIVE_FAILURES: u32 = 3;

    // Index subtasks for dependency lookups during context injection.
    let subtasks_by_id: HashMap<String, SubTask> = subtasks
        .iter()
        .cloned()
        .map(|st| (st.id.clone(), st))
        .collect();

    // Accumulates the final assistant content for each completed sub-task so
    // downstream layers can see what earlier sub-tasks produced (GH #1930).
    let subtask_results: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));

    'layers: for (layer_idx, layer) in layers.iter().enumerate() {
        log::info!(
            "[Orchestrator] Executing layer {} with {} subtask(s)",
            layer_idx,
            layer.len()
        );

        let mut handles = Vec::new();
        let mut active_workers: Vec<Arc<dyn Worker>> = Vec::new();
        // An error while spawning this layer's workers must not return past
        // the ones already spawned — they would keep running unsupervised and
        // the plan row would stay 'active' forever (GH #3445). Capture the
        // error, stop spawning, and clean up below instead.
        let mut layer_spawn_error: Option<String> = None;

        for subtask in layer {
            // Compute rankings for this subtask's task_type
            let mut subtask_caps = capabilities.clone();
            let rankings = get_rankings_for_task(
                app,
                &subtask.classification.task_type,
                &subtask_caps.available_models,
                0.1,
            )
            .await;

            subtask_caps.model_rankings = rankings
                .iter()
                .map(|r| (r.model_id.clone(), r.score))
                .collect();

            // Route each subtask independently with rankings
            let mut routing =
                router::route(&subtask.classification, &subtask_caps, &subtask.prompt);

            // Trust graduation per subtask
            let app_for_trust = app.clone();
            let task_type = subtask.classification.task_type.clone();
            let model_id = routing.model_id.clone();
            let trusted = tauri::async_runtime::spawn_blocking(move || {
                match crate::services::database::init_db(&app_for_trust) {
                    Ok(conn) => trust::is_trusted(&conn, &task_type, &model_id),
                    Err(_) => false,
                }
            })
            .await
            .unwrap_or(false);

            if trusted {
                routing.delegation = DelegationType::FullHandoff;
                routing.reason = format!("{} (trusted)", routing.reason);
            }

            // Load skill content
            let skill_content = match load_skill_content(&routing.selected_skills) {
                Ok(content) => content,
                Err(e) => {
                    layer_spawn_error = Some(e);
                    break;
                }
            };

            // Emit transition per subtask
            let transition = TransitionEvent {
                conversation_id: conversation_id.to_string(),
                model_name: routing.model_id.clone(),
                task_description: routing.reason.clone(),
            };
            if let Err(e) = app.emit("orchestrator://transition", &transition) {
                layer_spawn_error = Some(format!("Failed to emit transition: {}", e));
                break;
            }

            // Spawn worker — keep Arc clone for cancellation
            let worker = match create_worker(&routing, app, capabilities) {
                Ok(worker) => worker,
                Err(e) => {
                    layer_spawn_error = Some(e);
                    break;
                }
            };
            active_workers.push(Arc::clone(&worker));
            let subtask_prompt = subtask.prompt.clone();
            let subtask_id = subtask.id.clone();
            let worker_routing = routing.clone();
            let worker_app = app.clone();
            // Inject completed ancestor sub-task results so this worker sees
            // what earlier layers produced (GH #1930). For layer-0 sub-tasks
            // this is a no-op since they have no dependencies.
            let worker_history = {
                let snapshot = subtask_results.lock().await.clone();
                inject_dependency_results(
                    history,
                    subtask,
                    &subtasks_by_id,
                    &snapshot,
                    MAX_CONTEXT_SUBTASKS,
                    MAX_SUBTASK_RESULT_BYTES,
                )
            };
            let worker_images = images.to_vec();
            let layer_tx = shared_tx.clone();
            let worker_conversation_id = conversation_id.to_string();
            let results_for_handle = Arc::clone(&subtask_results);

            let handle = tokio::spawn(async move {
                let (tx, mut rx) = mpsc::channel::<WorkerEvent>(64);

                // Spawn worker execution
                let exec_handle = tokio::spawn(async move {
                    worker
                        .execute(
                            &worker_conversation_id,
                            &subtask_prompt,
                            &worker_history,
                            &worker_routing,
                            &skill_content,
                            &worker_app,
                            &worker_images,
                            tx,
                        )
                        .await
                });

                // Forward events tagged with subtask_id, accumulating the
                // assistant content so downstream sub-tasks can see it.
                let mut streamed_content = String::new();
                let mut final_content: Option<String> = None;
                while let Some(event) = rx.recv().await {
                    match &event {
                        WorkerEvent::Content { text } => {
                            streamed_content.push_str(text);
                        }
                        WorkerEvent::Complete {
                            final_content: fc, ..
                        } => {
                            if !fc.is_empty() {
                                final_content = Some(fc.clone());
                            }
                        }
                        _ => {}
                    }
                    if layer_tx.send((subtask_id.clone(), event)).await.is_err() {
                        break;
                    }
                }

                let captured = final_content.unwrap_or(streamed_content);
                if !captured.trim().is_empty() {
                    let mut results = results_for_handle.lock().await;
                    results.insert(subtask_id.clone(), captured);
                }

                exec_handle.await
            });

            handles.push(handle);
        }

        // A mid-layer spawn failure: stop the workers already spawned, close
        // the forwarding loop, and finalize the plan row before surfacing the
        // error (GH #3445).
        if let Some(spawn_error) = layer_spawn_error {
            log::error!(
                "[Orchestrator] Layer {} spawn failed after {} worker(s) started; cleaning up: {}",
                layer_idx,
                active_workers.len(),
                spawn_error
            );
            abort_layer(&active_workers, &handles).await;
            drop(shared_tx);
            let _ = forward_handle.await;
            finalize_plan(app, &plan_id, "failed").await;
            return Err(spawn_error);
        }

        // Wait for all workers in this layer before starting next
        let mut layer_had_success = false;
        let mut layer_fatal_error: Option<String> = None;
        let cancel_check = cancel_watch_rx.clone();
        for handle in handles {
            // If already cancelled, signal workers to stop and abort handles
            if *cancel_check.borrow() {
                for w in &active_workers {
                    cancel_worker_or_timeout(w.as_ref(), WORKER_CANCEL_TIMEOUT).await;
                }
                handle.abort();
                continue;
            }
            let mut cancel_for_handle = cancel_check.clone();
            let cancelled_during_await = tokio::select! {
                result = handle => {
                    match result {
                        Ok(Ok(Ok(()))) => {
                            layer_had_success = true;
                        }
                        Ok(Ok(Err(e))) => {
                            log::error!("[Orchestrator] Worker error in layer {}: {}", layer_idx, e);
                            // Check for fatal errors that should abort the entire plan
                            if e.contains("402 Payment Required")
                                || e.contains("Insufficient prepaid balance")
                            {
                                layer_fatal_error = Some(e);
                            }
                        }
                        Ok(Err(e)) => {
                            log::error!(
                                "[Orchestrator] Worker panicked in layer {}: {}",
                                layer_idx,
                                e
                            );
                        }
                        Err(e) => {
                            log::error!("[Orchestrator] Join error in layer {}: {}", layer_idx, e);
                        }
                    }
                    false
                }
                _ = cancel_for_handle.wait_for(|v| *v) => {
                    log::info!("[Orchestrator] Cancel arrived during layer {} handle await", layer_idx);
                    true
                }
            };
            if cancelled_during_await {
                for w in &active_workers {
                    cancel_worker_or_timeout(w.as_ref(), WORKER_CANCEL_TIMEOUT).await;
                }
                break;
            }
        }

        // After processing layer handles, stop if cancelled
        if *cancel_watch_rx.borrow() {
            log::info!("[Orchestrator] Cancellation detected — stopping layer execution");
            break 'layers;
        }

        // Abort immediately on fatal errors (e.g. no balance)
        if let Some(ref fatal) = layer_fatal_error {
            log::error!(
                "[Orchestrator] Fatal error in layer {}, aborting plan: {}",
                layer_idx,
                fatal
            );
            break 'layers;
        }

        // Track consecutive layer failures to detect systemic issues
        if layer_had_success {
            consecutive_failures = 0;
        } else {
            consecutive_failures += 1;
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                log::error!(
                    "[Orchestrator] {} consecutive layer failures, aborting plan",
                    consecutive_failures
                );
                break 'layers;
            }
        }
    }

    // Drop shared sender so forwarding loop terminates
    drop(shared_tx);
    let _ = forward_handle.await;

    // Mark plan as completed
    finalize_plan(app, &plan_id, "completed").await;

    log::info!(
        "[Orchestrator] Completed multi-task orchestration for conversation {} (plan {})",
        conversation_id,
        plan_id
    );

    Ok(())
}

/// Cancel an active orchestration by conversation ID.
///
/// Idempotent: calling twice on the same session is safe and silent (the
/// second call sees the flag is already `true` and returns without warning).
/// The session entry is kept in the map until `orchestrate()` cleanup so
/// repeated Stop clicks during the unwind do not produce spurious
/// "No active session" warnings (see GH #1581).
pub async fn cancel(state: &OrchestratorState, conversation_id: &str) -> Result<(), String> {
    let sessions = state.active_sessions.lock().await;
    if let Some(session) = sessions.get(conversation_id) {
        if *session.cancel_tx.borrow() {
            // Already cancelling — user clicked Stop again while the
            // orchestrator was still winding down. That is normal.
            log::debug!(
                "[Orchestrator] Cancel re-requested for conversation {} (already cancelling)",
                conversation_id
            );
            return Ok(());
        }
        let _ = session.cancel_tx.send(true);
        log::info!(
            "[Orchestrator] Sent cancel signal for conversation {}",
            conversation_id
        );
        Ok(())
    } else {
        log::warn!(
            "[Orchestrator] No active session for conversation {}",
            conversation_id
        );
        Ok(()) // Not an error — the session may have already completed
    }
}

// =============================================================================
// Worker Creation
// =============================================================================

/// Create the appropriate worker based on the routing decision.
fn create_worker(
    routing: &RoutingDecision,
    _app: &AppHandle,
    capabilities: &UserCapabilities,
) -> Result<Arc<dyn Worker>, String> {
    match routing.worker_type {
        WorkerType::ChatModel => Ok(Arc::new(ChatModelWorker::with_tools(
            capabilities.tool_definitions.clone(),
            routing.publisher_slug.clone(),
            capabilities.effective_agent_policy.clone(),
        ))),
        WorkerType::CloudAgent => {
            let deployment_id = capabilities
                .configured_private_chat_deployment_id()
                .ok_or_else(|| PRIVATE_CHAT_DEPLOYMENT_MISSING_MESSAGE.to_string())?
                .to_string();
            let worker = CloudAgentWorker::new(deployment_id)?;
            Ok(Arc::new(worker))
        }
        WorkerType::LocalAgent => Ok(Arc::new(
            super::provider_worker::ProviderRuntimeWorker::new(
                _app.clone(),
                capabilities.active_agent_session_id.clone(),
            ),
        )),
        WorkerType::McpPublisher => Ok(Arc::new(McpPublisherWorker::new())),
    }
}

// =============================================================================
// Skill Content Loading
// =============================================================================

/// Read SKILL.md content from disk for each selected skill.
///
/// Strips YAML frontmatter (everything between the first `---` pair).
/// Concatenates into a single string with headers for each skill.
/// Validates that skill paths are within expected directories.
pub fn load_skill_content(skills: &[SkillRef]) -> Result<String, String> {
    if skills.is_empty() {
        return Ok(String::new());
    }

    let mut sections = Vec::new();
    for skill in skills {
        // Security: validate the path ends with SKILL.md
        let path = Path::new(&skill.path);
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n != "SKILL.md")
            .unwrap_or(true)
        {
            log::warn!(
                "[Orchestrator] Skipping skill {} — path does not end with SKILL.md: {}",
                skill.slug,
                skill.path
            );
            continue;
        }

        let content = match std::fs::read_to_string(&skill.path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[Orchestrator] Failed to read skill {}: {}", skill.slug, e);
                continue; // Skip unreadable skills rather than failing the entire request
            }
        };

        let body = strip_frontmatter(&content);
        if !body.trim().is_empty() {
            sections.push(format!("## Skill: {}\n\n{}", skill.name, body));
        }
    }

    if sections.is_empty() {
        return Ok(String::new());
    }

    Ok(format!(
        "# Active Skills\n\n{}",
        sections.join("\n\n---\n\n")
    ))
}

/// Strip YAML frontmatter from a markdown document.
///
/// Frontmatter is delimited by `---` on its own line at the start of the file.
/// If the document starts with `---`, everything up to and including the
/// closing `---` is removed.
pub fn strip_frontmatter(content: &str) -> &str {
    let trimmed = content.trim_start();

    if !trimmed.starts_with("---") {
        return content;
    }

    // Find the closing ---
    let after_opening = &trimmed[3..];
    if let Some(close_pos) = after_opening.find("\n---") {
        // Skip past the closing --- and any trailing newline
        let remainder = &after_opening[close_pos + 4..];
        remainder.trim_start_matches('\n').trim_start_matches('\r')
    } else {
        // No closing --- found; return the whole content as-is
        content
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // Frontmatter Stripping
    // =========================================================================

    #[test]
    fn strips_yaml_frontmatter() {
        let content =
            "---\ntitle: Test Skill\ntags: [test]\n---\n# Skill Body\n\nThis is the skill content.";
        let result = strip_frontmatter(content);
        assert_eq!(result, "# Skill Body\n\nThis is the skill content.");
    }

    #[test]
    fn preserves_content_without_frontmatter() {
        let content = "# Just Markdown\n\nNo frontmatter here.";
        let result = strip_frontmatter(content);
        assert_eq!(result, content);
    }

    #[test]
    fn preserves_content_with_unclosed_frontmatter() {
        let content = "---\ntitle: Broken\nNo closing delimiter";
        let result = strip_frontmatter(content);
        assert_eq!(result, content);
    }

    #[test]
    fn handles_empty_content() {
        assert_eq!(strip_frontmatter(""), "");
    }

    #[test]
    fn handles_frontmatter_only() {
        let content = "---\ntitle: Just Frontmatter\n---\n";
        let result = strip_frontmatter(content);
        assert!(result.trim().is_empty());
    }

    // =========================================================================
    // Skill Content Loading
    // =========================================================================

    #[test]
    fn load_skill_content_empty_slice_returns_empty() {
        let result = load_skill_content(&[]).unwrap();
        assert_eq!(result, "");
    }

    #[test]
    fn load_skill_content_with_valid_skill() {
        // Create a temp file
        let dir = std::env::temp_dir().join("seren_test_skills");
        let skill_dir = dir.join("test-skill");
        std::fs::create_dir_all(&skill_dir).unwrap();
        let skill_path = skill_dir.join("SKILL.md");
        std::fs::write(
            &skill_path,
            "---\ntitle: Test\ntags: [test]\n---\n# Test Skill\n\nDo testing things.",
        )
        .unwrap();

        let skills = vec![SkillRef {
            slug: "test-skill".to_string(),
            name: "Test Skill".to_string(),
            description: "A test skill".to_string(),
            tags: vec!["test".to_string()],
            path: skill_path.to_string_lossy().to_string(),
        }];

        let result = load_skill_content(&skills).unwrap();
        assert!(result.contains("# Active Skills"));
        assert!(result.contains("## Skill: Test Skill"));
        assert!(result.contains("Do testing things."));
        // Frontmatter should be stripped
        assert!(!result.contains("tags: [test]"));

        // Clean up
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_skill_content_skips_nonexistent_paths() {
        let skills = vec![SkillRef {
            slug: "missing".to_string(),
            name: "Missing Skill".to_string(),
            description: String::new(),
            tags: vec![],
            path: "/nonexistent/path/SKILL.md".to_string(),
        }];

        let result = load_skill_content(&skills).unwrap();
        assert_eq!(result, ""); // Gracefully returns empty
    }

    #[test]
    fn load_skill_content_rejects_non_skill_paths() {
        let skills = vec![SkillRef {
            slug: "sneaky".to_string(),
            name: "Sneaky".to_string(),
            description: String::new(),
            tags: vec![],
            path: "/etc/passwd".to_string(),
        }];

        let result = load_skill_content(&skills).unwrap();
        assert_eq!(result, ""); // Rejected by path validation
    }

    #[test]
    fn load_skill_content_concatenates_multiple_skills() {
        let dir = std::env::temp_dir().join("seren_test_multi_skills");

        let skill1_dir = dir.join("skill-a");
        std::fs::create_dir_all(&skill1_dir).unwrap();
        let skill1_path = skill1_dir.join("SKILL.md");
        std::fs::write(&skill1_path, "# Skill A\n\nContent A.").unwrap();

        let skill2_dir = dir.join("skill-b");
        std::fs::create_dir_all(&skill2_dir).unwrap();
        let skill2_path = skill2_dir.join("SKILL.md");
        std::fs::write(&skill2_path, "# Skill B\n\nContent B.").unwrap();

        let skills = vec![
            SkillRef {
                slug: "skill-a".to_string(),
                name: "Skill A".to_string(),
                description: String::new(),
                tags: vec![],
                path: skill1_path.to_string_lossy().to_string(),
            },
            SkillRef {
                slug: "skill-b".to_string(),
                name: "Skill B".to_string(),
                description: String::new(),
                tags: vec![],
                path: skill2_path.to_string_lossy().to_string(),
            },
        ];

        let result = load_skill_content(&skills).unwrap();
        assert!(result.contains("## Skill: Skill A"));
        assert!(result.contains("## Skill: Skill B"));
        assert!(result.contains("---")); // Separator between skills

        let _ = std::fs::remove_dir_all(&dir);
    }

    // =========================================================================
    // Orchestrator State
    // =========================================================================

    #[tokio::test]
    async fn cancel_returns_ok_for_nonexistent_session() {
        let state = OrchestratorState::new();
        let result = cancel(&state, "nonexistent").await;
        assert!(result.is_ok());
    }

    #[test]
    fn completion_record_uses_shared_id_and_streamed_content() {
        let event = WorkerEvent::Complete {
            final_content: String::new(),
            thinking: None,
            cost: Some(0.25),
            rlm_steps: None,
        };
        let record = completion_message_record(
            "conv-1",
            "assistant-1",
            "streamed answer",
            &event,
            Some("anthropic/claude-sonnet-4"),
            Some("research"),
            1000,
            2500,
            Some("seren"),
        )
        .expect("complete event should build a persisted row");

        assert_eq!(record.id, "assistant-1");
        assert_eq!(record.conversation_id, "conv-1");
        assert_eq!(record.role, "assistant");
        assert_eq!(record.content, "streamed answer");
        assert_eq!(record.model.as_deref(), Some("anthropic/claude-sonnet-4"));
        assert_eq!(record.provider.as_deref(), Some("seren"));
        assert_eq!(record.timestamp, 2500);

        let metadata: serde_json::Value =
            serde_json::from_str(record.metadata.as_deref().unwrap()).unwrap();
        assert_eq!(metadata["v"], 1);
        assert_eq!(metadata["worker_type"], "orchestrator");
        assert_eq!(metadata["model_id"], "anthropic/claude-sonnet-4");
        assert_eq!(metadata["task_type"], "research");
        assert_eq!(metadata["duration"], 1500);
        assert_eq!(metadata["cost"], 0.25);
    }

    #[tokio::test]
    async fn cancel_flips_flag_and_keeps_session_entry() {
        // Contract (GH #1581): cancel() signals via the watch channel but
        // does NOT remove the session. The entry is cleaned up by
        // `orchestrate()` only when orchestration actually exits, so repeat
        // Stop clicks during the unwind find the session and are silent.
        let state = OrchestratorState::new();
        let (tx, mut rx) = watch::channel(false);
        state.register_session("test-conv", tx).await.unwrap();

        assert!(cancel(&state, "test-conv").await.is_ok());

        // Receiver observes the flag.
        rx.changed().await.unwrap();
        assert!(*rx.borrow());

        // Session entry still present — removal is orchestrate()'s job.
        let sessions = state.active_sessions.lock().await;
        assert!(sessions.contains_key("test-conv"));
    }

    // =========================================================================
    // Cancellation behaviour (GH #1581 regression tests — critical only)
    // =========================================================================

    #[tokio::test]
    async fn cancel_during_backoff_interrupts_sleep() {
        // The retry backoff used to be a plain `tokio::time::sleep`, which
        // silently swallowed Stop clicks. With `sleep_or_cancel`, a cancel
        // signal must interrupt the sleep promptly rather than waiting the
        // full backoff.
        let (tx, mut rx) = watch::channel(false);

        let sleep_task = tokio::spawn(async move {
            let t0 = std::time::Instant::now();
            let completed = sleep_or_cancel(std::time::Duration::from_secs(30), &mut rx).await;
            (completed, t0.elapsed())
        });

        // Let the sleep start, then fire cancel.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        tx.send(true).unwrap();

        let (completed, elapsed) = sleep_task.await.unwrap();
        assert!(!completed, "sleep should report cancellation");
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "cancel should interrupt sleep, took {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn cancel_propagates_across_multiple_retry_iterations() {
        // With a oneshot, the first iteration consumed the receiver and
        // later iterations were uncancellable. watch::Receiver is cloneable
        // and observable forever — a single `send(true)` propagates to
        // every subsequent clone.
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap();

        // Two sequential "iterations" each take a fresh clone, as
        // `execute_single_task` does per retry. Each fresh clone's "last
        // seen" version is 0, so `changed()` returns immediately because
        // the sender has already bumped to version 1 (cancel=true).
        for iter in 0..2 {
            let mut iter_rx = rx.clone();
            let result =
                tokio::time::timeout(std::time::Duration::from_millis(500), iter_rx.changed())
                    .await;
            assert!(result.is_ok(), "iter {} timed out waiting for cancel", iter);
            assert!(
                *iter_rx.borrow(),
                "iter {} should observe cancel=true",
                iter
            );
        }
    }

    #[tokio::test]
    async fn cancel_is_idempotent_for_repeat_clicks() {
        // A user mashing Stop three times during the retry unwind must not
        // produce "No active session" warnings — the session stays in the
        // map until orchestrate() exits.
        let state = OrchestratorState::new();
        let (tx, _rx) = watch::channel(false);
        state.register_session("test-conv", tx).await.unwrap();

        for _ in 0..3 {
            assert!(cancel(&state, "test-conv").await.is_ok());
        }

        // Session is still registered (orchestrate() will clean it up).
        let sessions = state.active_sessions.lock().await;
        assert!(sessions.contains_key("test-conv"));
        assert!(*sessions.get("test-conv").unwrap().cancel_tx.borrow());
    }

    // =========================================================================
    // Bounded worker cancel (GH #3433 regression tests)
    // =========================================================================

    /// Worker stub whose `cancel()` either resolves immediately or pends
    /// forever, reproducing a wedged runtime that accepts the cancel
    /// connection but never replies.
    struct CancelProbeWorker {
        hang_cancel: bool,
    }

    #[async_trait::async_trait]
    impl Worker for CancelProbeWorker {
        fn id(&self) -> &str {
            "cancel-probe"
        }

        async fn execute(
            &self,
            _conversation_id: &str,
            _prompt: &str,
            _conversation_context: &[serde_json::Value],
            _routing: &RoutingDecision,
            _skill_content: &str,
            _app: &tauri::AppHandle,
            _images: &[ImageAttachment],
            _event_tx: mpsc::Sender<WorkerEvent>,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn cancel(&self) -> Result<(), String> {
            if self.hang_cancel {
                std::future::pending::<()>().await;
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn hung_worker_cancel_unblocks_stop_at_timeout() {
        // Contract (GH #3433): a cancel() that never resolves must not block
        // orchestrate() past the timeout — Stop proceeds to abort() and the
        // session cleanup that follows, instead of leaving the conversation
        // stuck "running" until app restart.
        let worker = CancelProbeWorker { hang_cancel: true };
        let t0 = std::time::Instant::now();
        let resolved =
            cancel_worker_or_timeout(&worker, std::time::Duration::from_millis(100)).await;
        assert!(!resolved, "hung cancel must report timeout");
        assert!(
            t0.elapsed() < std::time::Duration::from_secs(5),
            "hung cancel must unblock promptly, took {:?}",
            t0.elapsed()
        );
    }

    #[tokio::test]
    async fn responsive_worker_cancel_resolves_within_timeout() {
        let worker = CancelProbeWorker { hang_cancel: false };
        let resolved = cancel_worker_or_timeout(&worker, WORKER_CANCEL_TIMEOUT).await;
        assert!(resolved, "responsive cancel must resolve inside the bound");
    }

    // =========================================================================
    // Session ownership guard (GH #3444 regression tests)
    // =========================================================================

    #[tokio::test]
    async fn second_register_for_same_conversation_is_rejected() {
        // Contract (GH #3444): a concurrent second orchestrate for the same
        // conversation must be rejected, not replace the first run's session.
        // Replacing would drop run 1's cancel sender — leaving it
        // uncancellable and hot-spinning its forward loop on a closed watch
        // channel — while run 1's cleanup would then evict run 2's entry.
        let state = OrchestratorState::new();
        let (tx1, mut rx1) = watch::channel(false);
        state
            .register_session("conv", tx1)
            .await
            .expect("first register succeeds");

        let (tx2, _rx2) = watch::channel(false);
        let second = state.register_session("conv", tx2).await;
        let err = second.expect_err("second concurrent register must be rejected");
        assert!(
            err.contains("already in progress"),
            "rejection must explain the conflict, got: {err}"
        );

        // First run stays cancellable through the session map.
        assert!(cancel(&state, "conv").await.is_ok());
        rx1.changed()
            .await
            .expect("first run's cancel channel must stay live");
        assert!(*rx1.borrow());
    }

    #[tokio::test]
    async fn stale_release_does_not_evict_newer_run() {
        // Contract (GH #3444): cleanup removes the session entry only when
        // the finishing run still owns it. A stale release (older token)
        // must leave the newer run's entry — and its cancellability — intact.
        let state = OrchestratorState::new();
        let (tx1, _rx1) = watch::channel(false);
        let token1 = state.register_session("conv", tx1).await.unwrap();
        assert!(state.release_session("conv", token1).await);

        let (tx2, mut rx2) = watch::channel(false);
        let token2 = state.register_session("conv", tx2).await.unwrap();
        assert_ne!(token1, token2, "each run must get its own token");

        assert!(
            !state.release_session("conv", token1).await,
            "a stale release must be a no-op"
        );
        {
            let sessions = state.active_sessions.lock().await;
            assert!(
                sessions.contains_key("conv"),
                "the newer run's session must survive a stale release"
            );
        }

        // The newer run is still cancellable, and its own release works.
        assert!(cancel(&state, "conv").await.is_ok());
        rx2.changed().await.unwrap();
        assert!(*rx2.borrow());
        assert!(state.release_session("conv", token2).await);
    }

    // =========================================================================
    // Mid-layer spawn failure cleanup (GH #3445 regression tests)
    // =========================================================================

    #[tokio::test]
    async fn abort_layer_cancels_workers_and_aborts_handles() {
        // Contract (GH #3445): when spawning a layer fails partway (e.g. the
        // transition emit fails because the webview is gone), the workers
        // already spawned must be cancelled and their tasks aborted instead
        // of running — and spending — unsupervised. Hung-cancel boundedness
        // is covered by hung_worker_cancel_unblocks_stop_at_timeout.
        let workers: Vec<Arc<dyn Worker>> = vec![
            Arc::new(CancelProbeWorker { hang_cancel: false }),
            Arc::new(CancelProbeWorker { hang_cancel: false }),
        ];
        let handles: Vec<tokio::task::JoinHandle<()>> = (0..2)
            .map(|_| tokio::spawn(std::future::pending::<()>()))
            .collect();

        abort_layer(&workers, &handles).await;

        for handle in handles {
            let joined = handle.await;
            assert!(
                joined.expect_err("pending task must not complete").is_cancelled(),
                "spawned layer tasks must be aborted"
            );
        }
    }

    #[test]
    fn finalize_plan_row_sets_terminal_status() {
        // Contract (GH #3445): the mid-layer failure path must finalize the
        // plan row so it can never sit 'active' forever.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE orchestration_plans (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                original_prompt TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at INTEGER NOT NULL,
                completed_at INTEGER
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO orchestration_plans (id, conversation_id, original_prompt, status, created_at)
             VALUES ('p1', 'c1', 'prompt', 'active', 1000)",
            [],
        )
        .unwrap();

        let updated = finalize_plan_row(&conn, "p1", "failed", 2000).unwrap();
        assert_eq!(updated, 1);

        let (status, completed_at): (String, i64) = conn
            .query_row(
                "SELECT status, completed_at FROM orchestration_plans WHERE id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "failed");
        assert_eq!(completed_at, 2000);

        // Finalizing a plan that does not exist touches nothing.
        assert_eq!(finalize_plan_row(&conn, "missing", "failed", 3000).unwrap(), 0);
    }

    // =========================================================================
    // Completion Integrity (#3193-C)
    // =========================================================================

    fn send_cap() -> crate::approval_continuation::RequestedCapability {
        crate::approval_continuation::RequestedCapability {
            route: "gateway".to_string(),
            publisher_slug: "gmail".to_string(),
            tool_name: "post_send".to_string(),
            operation_class: "high-risk".to_string(),
            description: "Send email".to_string(),
            is_destructive: false,
            command: None,
            host: None,
            target: None,
            binding: None,
        }
    }

    /// The real completion path (`guard_completion` over the real
    /// `ToolAuthorizationState`) enforces criterion #6: when a `Complete` arrives
    /// with an approval still pending, the host settles that orphan and the emitted
    /// completion carries no unresolved required approval. The event stays a
    /// `Complete` (never suppressed — that would leave the turn with no terminal
    /// frame, the hung-agent symptom), its summary discloses the lapsed work, and
    /// the store reports the block terminally expired. No mocks: a real mock Tauri
    /// app with a real in-memory authorization store.
    #[test]
    fn guard_completion_settles_pending_approval_before_completing() {
        use tauri::Manager;

        let app = tauri::test::mock_builder()
            .manage(crate::tool_authorization::ToolAuthorizationState::new(
                std::path::PathBuf::from(":memory:"),
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");

        let state = app.state::<crate::tool_authorization::ToolAuthorizationState>();
        state
            .register_continuation(
                "conv-a",
                send_cap(),
                crate::approval_continuation::ContinuationScope::Linear,
                300,
            )
            .expect("register continuation");
        // Precondition: the task genuinely cannot complete while the block is open.
        assert!(!state.resolution_summary("conv-a").unwrap().can_complete());

        let completed = guard_completion(
            app.handle(),
            "conv-a",
            WorkerEvent::Complete {
                final_content: "Done.".to_string(),
                thinking: None,
                cost: None,
                rlm_steps: None,
            },
        );

        // The event is still a completion (not suppressed) and discloses the lapse.
        let WorkerEvent::Complete { final_content, .. } = completed else {
            panic!("guard_completion must keep the completion event, never suppress it");
        };
        assert!(final_content.starts_with("Done."));
        assert!(final_content.contains("not performed"));
        assert!(final_content.contains("1 expired"));

        // The invariant now holds in the store: a completed task carries no
        // unresolved required approval, and the block is terminally `expired`.
        let summary = state.resolution_summary("conv-a").unwrap();
        assert_eq!(summary.unresolved, 0);
        assert_eq!(summary.expired, 1);
        assert!(summary.can_complete());
        let views = state.list_continuations("conv-a").unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(
            views[0].state,
            crate::approval_continuation::ContinuationState::Expired
        );
    }

    /// A clean completion (nothing pending) is forwarded untouched — no spurious
    /// disclosure, no wasted mutation. Guards against the enforcement path bleeding
    /// into the common healthy turn.
    #[test]
    fn guard_completion_leaves_clean_completions_untouched() {
        use tauri::Manager;

        let app = tauri::test::mock_builder()
            .manage(crate::tool_authorization::ToolAuthorizationState::new(
                std::path::PathBuf::from(":memory:"),
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        // Touch the state so its in-memory store is bootstrapped like production.
        let _ = app
            .state::<crate::tool_authorization::ToolAuthorizationState>()
            .resolution_summary("conv-clean");

        let completed = guard_completion(
            app.handle(),
            "conv-clean",
            WorkerEvent::Complete {
                final_content: "All good.".to_string(),
                thinking: Some("t".to_string()),
                cost: Some(1.5),
                rlm_steps: None,
            },
        );

        let WorkerEvent::Complete {
            final_content,
            thinking,
            cost,
            ..
        } = completed
        else {
            panic!("expected a completion event");
        };
        assert_eq!(final_content, "All good.");
        assert_eq!(thinking.as_deref(), Some("t"));
        assert_eq!(cost, Some(1.5));
    }
}
