// ABOUTME: Orchestrator service that ties classifier, router, and workers together.
// ABOUTME: Provides the main orchestrate() entry point called by Tauri commands.

use log;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

use super::chat_model_worker::ChatModelWorker;
use super::classifier;
use super::decomposer;
use super::mcp_publisher_worker::McpPublisherWorker;
use super::router;
use super::trust;
use super::types::{
    DelegationType, ImageAttachment, OrchestratorEvent, RoutingDecision, SkillRef, SubTask,
    TransitionEvent, UserCapabilities, WorkerEvent, WorkerType,
};
use super::worker::Worker;

// =============================================================================
// Orchestrator State
// =============================================================================

/// Managed state for the orchestrator, tracking active sessions for cancellation.
pub struct OrchestratorState {
    /// Map of conversation_id → cancellation sender.
    /// Sending on a cancel channel signals the orchestrator to stop.
    active_sessions: Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
}

impl OrchestratorState {
    pub fn new() -> Self {
        Self {
            active_sessions: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for OrchestratorState {
    fn default() -> Self {
        Self::new()
    }
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
    prompt: String,
    history: Vec<serde_json::Value>,
    capabilities: UserCapabilities,
    images: Vec<ImageAttachment>,
) -> Result<(), String> {
    log::info!(
        "[Orchestrator] Starting orchestration for conversation {}",
        conversation_id
    );

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

    // 3. Register cancellation
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let mut sessions = state.active_sessions.lock().await;
        sessions.insert(conversation_id.clone(), cancel_tx);
    }

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
        )
        .await
    };

    // 5. Clean up session
    {
        let mut sessions = state.active_sessions.lock().await;
        sessions.remove(&conversation_id);
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
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    // Compute Thompson sampling rankings before routing
    let mut capabilities = capabilities.clone();
    let app_for_db = app.clone();
    let task_type_for_db = subtask.classification.task_type.clone();
    let available_models = capabilities.available_models.clone();

    let (rankings, _) = tauri::async_runtime::spawn_blocking(move || {
        match crate::services::database::init_db(&app_for_db) {
            Ok(conn) => {
                let mut rng = rand::rng();
                let rankings = trust::get_model_rankings(
                    &conn,
                    &mut rng,
                    &task_type_for_db,
                    &available_models,
                    0.1,
                );
                (rankings, true)
            }
            Err(_) => (vec![], false),
        }
    })
    .await
    .unwrap_or((vec![], false));

    capabilities.model_rankings = rankings
        .iter()
        .map(|r| (r.model_id.clone(), r.score))
        .collect();

    let user_explicitly_selected = capabilities
        .selected_model
        .as_ref()
        .is_some_and(|m| !m.is_empty());

    // Route with rankings-enriched capabilities
    let mut routing = router::route(&subtask.classification, &capabilities);

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

    // Wrap cancel_rx in Arc<Mutex> so it survives reroute iterations
    let cancel_rx = Arc::new(Mutex::new(Some(cancel_rx)));

    loop {
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
        let worker = create_worker(&routing, app, &capabilities);
        let worker_prompt = subtask.prompt.clone();
        let worker_routing = routing.clone();
        let worker_app = app.clone();
        let worker_images = images.to_vec();
        let worker_history = history.to_vec();
        let worker_handle = tokio::spawn(async move {
            worker
                .execute(
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

        // Collect events, looking for reroutable errors
        let conv_id = conversation_id.to_string();
        let app_for_events = app.clone();
        let cancel_rx_clone = cancel_rx.clone();

        // Collect all events, intercepting errors for reroute analysis
        let mut reroutable_error: Option<String> = None;
        let forward_handle = tokio::spawn(async move {
            let mut taken_rx = cancel_rx_clone.lock().await.take();
            let mut captured_error: Option<String> = None;
            loop {
                if let Some(ref mut rx) = taken_rx {
                    tokio::select! {
                        event = event_rx.recv() => {
                            match event {
                                Some(worker_event) => {
                                    // Capture error messages for reroute analysis
                                    if let WorkerEvent::Error { ref message } = worker_event {
                                        captured_error = Some(message.clone());
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
                        _ = rx => {
                            log::info!("[Orchestrator] Cancellation received for conversation {}", conv_id);
                            break;
                        }
                    }
                } else {
                    // No cancel_rx available (already consumed), just forward events
                    match event_rx.recv().await {
                        Some(worker_event) => {
                            if let WorkerEvent::Error { ref message } = worker_event {
                                captured_error = Some(message.clone());
                            }
                            let orchestrator_event = OrchestratorEvent {
                                conversation_id: conv_id.clone(),
                                worker_event,
                                subtask_id: None,
                            };
                            if let Err(e) =
                                app_for_events.emit("orchestrator://event", &orchestrator_event)
                            {
                                log::error!("[Orchestrator] Failed to emit event: {}", e);
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
            captured_error
        });

        let forward_result = forward_handle.await;
        if let Ok(Some(error_msg)) = &forward_result {
            reroutable_error = Some(error_msg.clone());
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
                    reroutable_error = Some(e);
                }
            }
            Err(e) => {
                log::error!("[Orchestrator] Worker task panicked: {}", e);
                let error_event = OrchestratorEvent {
                    conversation_id: conversation_id.to_string(),
                    worker_event: WorkerEvent::Error {
                        message: "Internal error: worker task failed".to_string(),
                    },
                    subtask_id: None,
                };
                let _ = app.emit("orchestrator://event", &error_event);
            }
        }

        // Check if we got a transient error eligible for retry/reroute
        let is_transient = reroutable_error
            .as_ref()
            .is_some_and(|msg| router::is_reroutable_error(msg));

        if !is_transient {
            break;
        }

        let error_msg = reroutable_error.unwrap();

        // When user explicitly selected a model, retry the same model once
        // instead of rerouting to a different one.
        if user_explicitly_selected {
            if same_model_retry_count >= MAX_SAME_MODEL_RETRIES {
                log::warn!(
                    "[Orchestrator] Transient error on explicitly-selected model {} after {} retry, giving up: {}",
                    routing.model_id,
                    same_model_retry_count,
                    error_msg,
                );
                break;
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
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }

        // Auto-selected model: reroute to a different model
        if reroute_count >= router::MAX_REROUTE_ATTEMPTS {
            log::warn!(
                "[Orchestrator] Giving up after {} reroute attempts",
                reroute_count
            );
            break;
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
                break;
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
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
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
            let routing = router::route(&st.classification, capabilities);
            (st.id.clone(), st.prompt.clone(), routing.model_id.clone())
        })
        .collect();
    let subtask_meta: Vec<(String, String, String, String)> = subtasks
        .iter()
        .map(|st| {
            let routing = router::route(&st.classification, capabilities);
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
    let forward_handle = tokio::spawn(async move {
        let mut cancel_rx = cancel_rx;
        loop {
            tokio::select! {
                event = shared_rx.recv() => {
                    match event {
                        Some((subtask_id, worker_event)) => {
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
                _ = &mut cancel_rx => {
                    log::info!("[Orchestrator] Cancellation received for multi-task conversation {}", conv_id);
                    break;
                }
            }
        }
    });

    // Execute subtasks layer by layer
    let layers = decomposer::dependency_layers(&subtasks);

    for (layer_idx, layer) in layers.iter().enumerate() {
        log::info!(
            "[Orchestrator] Executing layer {} with {} subtask(s)",
            layer_idx,
            layer.len()
        );

        let mut handles = Vec::new();

        for subtask in layer {
            // Compute rankings for this subtask's task_type
            let mut subtask_caps = capabilities.clone();
            let app_for_rank = app.clone();
            let task_type_for_rank = subtask.classification.task_type.clone();
            let models_for_rank = subtask_caps.available_models.clone();

            let rankings = tauri::async_runtime::spawn_blocking(move || {
                match crate::services::database::init_db(&app_for_rank) {
                    Ok(conn) => {
                        let mut rng = rand::rng();
                        trust::get_model_rankings(
                            &conn,
                            &mut rng,
                            &task_type_for_rank,
                            &models_for_rank,
                            0.1,
                        )
                    }
                    Err(_) => vec![],
                }
            })
            .await
            .unwrap_or_default();

            subtask_caps.model_rankings = rankings
                .iter()
                .map(|r| (r.model_id.clone(), r.score))
                .collect();

            // Route each subtask independently with rankings
            let mut routing = router::route(&subtask.classification, &subtask_caps);

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
            let skill_content = load_skill_content(&routing.selected_skills)?;

            // Emit transition per subtask
            let transition = TransitionEvent {
                conversation_id: conversation_id.to_string(),
                model_name: routing.model_id.clone(),
                task_description: routing.reason.clone(),
            };
            app.emit("orchestrator://transition", &transition)
                .map_err(|e| format!("Failed to emit transition: {}", e))?;

            // Spawn worker
            let worker = create_worker(&routing, app, &capabilities);
            let subtask_prompt = subtask.prompt.clone();
            let subtask_id = subtask.id.clone();
            let worker_routing = routing.clone();
            let worker_app = app.clone();
            let worker_history = history.to_vec();
            let worker_images = images.to_vec();
            let layer_tx = shared_tx.clone();

            let handle = tokio::spawn(async move {
                let (tx, mut rx) = mpsc::channel::<WorkerEvent>(64);

                // Spawn worker execution
                let exec_handle = tokio::spawn(async move {
                    worker
                        .execute(
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

                // Forward events tagged with subtask_id
                while let Some(event) = rx.recv().await {
                    if layer_tx.send((subtask_id.clone(), event)).await.is_err() {
                        break;
                    }
                }

                exec_handle.await
            });

            handles.push(handle);
        }

        // Wait for all workers in this layer before starting next
        for handle in handles {
            match handle.await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(e))) => {
                    log::error!("[Orchestrator] Worker error in layer {}: {}", layer_idx, e);
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
        }
    }

    // Drop shared sender so forwarding loop terminates
    drop(shared_tx);
    let _ = forward_handle.await;

    // Mark plan as completed
    let app_for_complete = app.clone();
    let plan_id_for_complete = plan_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(conn) = crate::services::database::init_db(&app_for_complete) {
            let completed_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;
            let _ = conn.execute(
                "UPDATE orchestration_plans SET status = 'completed', completed_at = ?1 WHERE id = ?2",
                rusqlite::params![completed_at, plan_id_for_complete],
            );
        }
    })
    .await
    .ok();

    log::info!(
        "[Orchestrator] Completed multi-task orchestration for conversation {} (plan {})",
        conversation_id,
        plan_id
    );

    Ok(())
}

/// Cancel an active orchestration by conversation ID.
pub async fn cancel(state: &OrchestratorState, conversation_id: &str) -> Result<(), String> {
    let mut sessions = state.active_sessions.lock().await;
    if let Some(cancel_tx) = sessions.remove(conversation_id) {
        let _ = cancel_tx.send(());
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
) -> Arc<dyn Worker> {
    match routing.worker_type {
        WorkerType::ChatModel => Arc::new(ChatModelWorker::with_tools(
            capabilities.tool_definitions.clone(),
        )),
        WorkerType::AcpAgent => {
            // ACP worker requires feature flag; fall back to chat model if not available
            #[cfg(feature = "acp")]
            {
                let worker = super::acp_worker::AcpWorker::new(_app.clone(), None);
                Arc::new(worker)
            }
            #[cfg(not(feature = "acp"))]
            {
                log::warn!(
                    "[Orchestrator] ACP feature not enabled, falling back to ChatModel worker"
                );
                Arc::new(ChatModelWorker::with_tools(
                    capabilities.tool_definitions.clone(),
                ))
            }
        }
        WorkerType::McpPublisher => Arc::new(McpPublisherWorker::new()),
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

    #[tokio::test]
    async fn cancel_removes_session_and_sends_signal() {
        let state = OrchestratorState::new();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();

        {
            let mut sessions = state.active_sessions.lock().await;
            sessions.insert("test-conv".to_string(), tx);
        }

        let result = cancel(&state, "test-conv").await;
        assert!(result.is_ok());

        // The receiver should have gotten the signal
        assert!(rx.await.is_ok());

        // Session should be removed
        let sessions = state.active_sessions.lock().await;
        assert!(!sessions.contains_key("test-conv"));
    }
}
