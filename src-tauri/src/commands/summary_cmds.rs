use sqlx::SqlitePool;
use tauri::State;

use crate::{backup::DataOperationLock, db::{models::Summary, summary}};

#[tauri::command]
pub async fn get_summary(
    meeting_id: String,
    pool: State<'_, SqlitePool>,
) -> Result<Option<Summary>, String> {
    summary::get_summary(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_summary(
    meeting_id: String,
    content: String,
    provider: String,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<Summary, String> {
    let _guard = data_lock.try_begin_write()?;
    summary::upsert_summary(&pool, &meeting_id, &content, &provider)
        .await
        .map_err(|e| e.to_string())
}
