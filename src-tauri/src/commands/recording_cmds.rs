use sqlx::SqlitePool;
use tauri::State;

use crate::db::{models::Recording, recording};

#[tauri::command]
pub async fn get_recording(
    meeting_id: String,
    pool: State<'_, SqlitePool>,
) -> Result<Option<Recording>, String> {
    recording::get_recording(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_recording(
    meeting_id: String,
    file_path: String,
    duration_seconds: Option<i64>,
    pool: State<'_, SqlitePool>,
) -> Result<Recording, String> {
    recording::upsert_recording(&pool, &meeting_id, Some(&file_path), duration_seconds)
        .await
        .map_err(|e| e.to_string())
}
