use std::path::PathBuf;

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use crate::audio_recording::{
    self, DesktopRecordingManager, RecordingDeviceList, RecordingPreview, StartRecordingRequest,
};
use crate::backup::DataOperationLock;
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
    data_lock: State<'_, DataOperationLock>,
) -> Result<Recording, String> {
    let _guard = data_lock.try_begin_write()?;
    recording::create_recording(
        &pool,
        &meeting_id,
        Some(&file_path),
        original_file_name.as_deref(),
        duration_seconds,
        None,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 將既有音訊檔（來自使用者選檔的真實路徑）複製進 recordings 目錄後存路徑至 DB
/// 全程在檔案系統層完成，不透過 IPC 傳輸位元組，避免大檔案撐爆 webview 記憶體
#[tauri::command]
pub async fn import_recording_file(
    meeting_id: String,
    source_path: String,
    file_name: String,
    original_file_name: Option<String>,
    duration_seconds: Option<i64>,
    app_handle: AppHandle,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<Recording, String> {
    let _guard = data_lock.try_begin_write()?;
    let recordings_dir = resolve_recordings_dir(&app_handle).map_err(|e| e.to_string())?;
    let source = PathBuf::from(&source_path);
    if !source.exists() {
        return Err("來源音訊檔不存在".into());
    }

    let file_path = recordings_dir.join(&file_name);
    let file_path = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        std::fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
        std::fs::copy(&source, &file_path).map_err(|e| e.to_string())?;
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
        None,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_recording_devices() -> Result<RecordingDeviceList, String> {
    audio_recording::list_recording_devices().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_desktop_recording(
    request: StartRecordingRequest,
    app_handle: AppHandle,
    manager: State<'_, DesktopRecordingManager>,
) -> Result<(), String> {
    audio_recording::start_recording(manager.inner(), &app_handle, request)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_desktop_recording(
    manager: State<'_, DesktopRecordingManager>,
) -> Result<RecordingPreview, String> {
    audio_recording::stop_recording(manager.inner()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_desktop_recording(
    manager: State<'_, DesktopRecordingManager>,
) -> Result<(), String> {
    audio_recording::cancel_recording(manager.inner()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discard_temp_recording_file(file_path: String) -> Result<(), String> {
    audio_recording::discard_temp_recording(&file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn commit_temporary_recording(
    meeting_id: String,
    temp_file_path: String,
    original_file_name: Option<String>,
    duration_seconds: Option<i64>,
    source_mode: Option<String>,
    app_handle: AppHandle,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<Recording, String> {
    let _guard = data_lock.try_begin_write()?;
    let recordings_dir = resolve_recordings_dir(&app_handle).map_err(|e| e.to_string())?;
    let temp_path = PathBuf::from(&temp_file_path);
    if !temp_path.exists() {
        return Err("暫存錄音檔不存在".into());
    }

    let final_name = format!("{meeting_id}_{}.wav", chrono::Utc::now().timestamp_millis());
    let final_path = recordings_dir.join(final_name);
    let final_path_for_move = final_path.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
        std::fs::rename(&temp_path, &final_path_for_move).or_else(|_| {
            std::fs::copy(&temp_path, &final_path_for_move)
                .map(|_| ())
                .and_then(|_| std::fs::remove_file(&temp_path))
        })
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    recording::create_recording(
        &pool,
        &meeting_id,
        Some(&final_path.to_string_lossy()),
        original_file_name.as_deref(),
        duration_seconds,
        source_mode.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_recording(
    recording_id: String,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<(), String> {
    let _guard = data_lock.try_begin_write()?;
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
    data_lock: State<'_, DataOperationLock>,
) -> Result<(), String> {
    let _guard = data_lock.try_begin_write()?;
    recording::set_no_break_before(&pool, &recording_id, no_break_before)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_recordings(
    meeting_id: String,
    recording_ids: Vec<String>,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<Vec<Recording>, String> {
    let _guard = data_lock.try_begin_write()?;
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
    data_lock: State<'_, DataOperationLock>,
) -> Result<String, String> {
    let _guard = data_lock.try_begin_write()?;
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
