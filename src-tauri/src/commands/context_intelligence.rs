use crate::services::context_intelligence::{
    SourceOutline, build_source_outline, run_ordered_batch,
};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct BatchIndexFileResult {
    pub path: String,
    pub outline: Option<SourceOutline>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn seren_index_source(path: String, source: String) -> Result<SourceOutline, String> {
    build_source_outline(&path, &source)
}

#[tauri::command]
pub async fn seren_index_file(path: String) -> Result<SourceOutline, String> {
    let source = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("failed to read {path}: {e}"))?;
    build_source_outline(&path, &source)
}

#[tauri::command]
pub async fn seren_batch_index_files(paths: Vec<String>) -> Vec<BatchIndexFileResult> {
    let jobs = paths.into_iter().map(|path| async move {
        match read_and_index_file(&path).await {
            Ok(outline) => BatchIndexFileResult {
                path,
                outline: Some(outline),
                error: None,
            },
            Err(error) => BatchIndexFileResult {
                path,
                outline: None,
                error: Some(error),
            },
        }
    });

    run_ordered_batch(jobs.collect()).await
}

async fn read_and_index_file(path: &str) -> Result<SourceOutline, String> {
    let source = tokio::fs::read_to_string(Path::new(path))
        .await
        .map_err(|e| format!("failed to read {path}: {e}"))?;
    build_source_outline(path, &source)
}
