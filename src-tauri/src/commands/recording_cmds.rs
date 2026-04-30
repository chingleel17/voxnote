use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

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

/// 接收音訊位元組，寫入 {app_data_dir}/recordings/ 後存路徑至 DB
#[tauri::command]
pub async fn write_recording_file(
    meeting_id: String,
    file_data: Vec<u8>,
    file_name: String,
    duration_seconds: Option<i64>,
    app_handle: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<Recording, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let recordings_dir = app_data_dir.join("recordings");
    std::fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;

    let file_path = recordings_dir.join(&file_name);
    std::fs::write(&file_path, &file_data).map_err(|e| e.to_string())?;

    let file_path_str = file_path.to_string_lossy().to_string();

    recording::upsert_recording(&pool, &meeting_id, Some(&file_path_str), duration_seconds)
        .await
        .map_err(|e| e.to_string())
}
