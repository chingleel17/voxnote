use std::path::PathBuf;

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use crate::db::{models::Recording, recording, transcript};
use crate::config::load_config;

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
pub async fn get_recordings(
    meeting_id: String,
    pool: State<'_, SqlitePool>,
) -> Result<Vec<Recording>, String> {
    recording::get_recordings(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_recording(
    meeting_id: String,
    file_path: String,
    original_file_name: Option<String>,
    duration_seconds: Option<i64>,
    pool: State<'_, SqlitePool>,
) -> Result<Recording, String> {
    recording::create_recording(
        &pool,
        &meeting_id,
        Some(&file_path),
        original_file_name.as_deref(),
        duration_seconds,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 接收音訊位元組，寫入 {app_data_dir}/recordings/ 後存路徑至 DB
#[tauri::command]
pub async fn write_recording_file(
    meeting_id: String,
    file_data: Vec<u8>,
    file_name: String,
    original_file_name: Option<String>,
    duration_seconds: Option<i64>,
    app_handle: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<Recording, String> {
    let recordings_dir = resolve_recordings_dir(&app_handle).map_err(|e| e.to_string())?;
    let file_path = recordings_dir.join(&file_name);
    let file_path = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        std::fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
        std::fs::write(&file_path, &file_data).map_err(|e| e.to_string())?;
        Ok(file_path)
    })
    .await
    .map_err(|e| e.to_string())??;

    let file_path_str = file_path.to_string_lossy().to_string();

    recording::create_recording(
        &pool,
        &meeting_id,
        Some(&file_path_str),
        original_file_name.as_deref(),
        duration_seconds,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_recording_file(file_path: String) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || std::fs::read(file_path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_recording(
    recording_id: String,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    if let Some(meeting_id) = recording::delete_recording(&pool, &recording_id)
        .await
        .map_err(|e| e.to_string())?
    {
        transcript::sync_generated_content_from_recordings(&pool, &meeting_id, false)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn set_no_break_before(
    recording_id: String,
    no_break_before: bool,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    recording::set_no_break_before(&pool, &recording_id, no_break_before)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_recordings(
    meeting_id: String,
    recording_ids: Vec<String>,
    pool: State<'_, SqlitePool>,
) -> Result<Vec<Recording>, String> {
    let reordered = recording::reorder_recordings(&pool, &meeting_id, &recording_ids)
        .await
        .map_err(|e| e.to_string())?;

    transcript::sync_generated_content_from_recordings(&pool, &meeting_id, true)
        .await
        .map_err(|e| e.to_string())?;

    Ok(reordered)
}

/// 重新合併所有段落逐字稿（不重新轉譯），依 no_break_before 設定決定是否插入中場休息
#[tauri::command]
pub async fn remerge_segments(
    meeting_id: String,
    pool: State<'_, SqlitePool>,
) -> Result<String, String> {
    let segments = recording::get_segment_transcripts_with_break(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?;
    let merged = recording::merge_segment_texts(&segments);

    transcript::sync_generated_content_from_recordings(&pool, &meeting_id, true)
        .await
        .map_err(|e| e.to_string())?;

    Ok(merged)
}

fn resolve_recordings_dir(app_handle: &AppHandle) -> Result<PathBuf, anyhow::Error> {
    let config = load_config(app_handle)?;
    let custom_dir = config.recording_storage_dir.trim();
    if !custom_dir.is_empty() {
        return Ok(PathBuf::from(custom_dir));
    }

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    Ok(app_data_dir.join("recordings"))
}
