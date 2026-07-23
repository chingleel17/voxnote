use sqlx::SqlitePool;
use tauri::State;

use crate::{backup::DataOperationLock, db::{models::Transcript, transcript}};

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
    data_lock: State<'_, DataOperationLock>,
) -> Result<Transcript, String> {
    let _guard = data_lock.try_begin_write()?;
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
    data_lock: State<'_, DataOperationLock>,
) -> Result<Transcript, String> {
    let _guard = data_lock.try_begin_write()?;
    transcript::update_proofread(&pool, &meeting_id, &proofread_content, &provider, None)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_transcript_manual(
    meeting_id: String,
    manual_content: String,
    base_version: String,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<Transcript, String> {
    let _guard = data_lock.try_begin_write()?;
    transcript::update_manual(&pool, &meeting_id, &manual_content, &base_version)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn switch_transcript_version(
    meeting_id: String,
    version: String,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<Transcript, String> {
    let _guard = data_lock.try_begin_write()?;
    transcript::switch_version(&pool, &meeting_id, &version)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("無法寫入檔案：{}", e))
}
