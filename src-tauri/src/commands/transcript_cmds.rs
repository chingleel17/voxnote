use sqlx::SqlitePool;
use tauri::State;

use crate::db::{models::Transcript, transcript};

#[tauri::command]
pub async fn get_transcript(
    meeting_id: String,
    pool: State<'_, SqlitePool>,
) -> Result<Option<Transcript>, String> {
    transcript::get_transcript(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_transcript_original(
    meeting_id: String,
    content: String,
    pool: State<'_, SqlitePool>,
) -> Result<Transcript, String> {
    transcript::upsert_transcript_original(&pool, &meeting_id, &content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_transcript_proofread(
    meeting_id: String,
    proofread_content: String,
    provider: String,
    pool: State<'_, SqlitePool>,
) -> Result<Transcript, String> {
    transcript::update_proofread(&pool, &meeting_id, &proofread_content, &provider)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_transcript_manual(
    meeting_id: String,
    manual_content: String,
    base_version: String,
    pool: State<'_, SqlitePool>,
) -> Result<Transcript, String> {
    transcript::update_manual(&pool, &meeting_id, &manual_content, &base_version)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn switch_transcript_version(
    meeting_id: String,
    version: String,
    pool: State<'_, SqlitePool>,
) -> Result<Transcript, String> {
    transcript::switch_version(&pool, &meeting_id, &version)
        .await
        .map_err(|e| e.to_string())
}
