use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use crate::audio_recording::{
    self, DesktopRecordingManager, RecordingDeviceList, RecordingPreview, StartRecordingRequest,
};
use crate::backup::DataOperationLock;
use crate::config::load_config;
use crate::db::{
    models::{
        Recording, RecordingImportBatchResult, RecordingImportItem, RecordingImportItemResult,
    },
    recording, transcript,
};
use crate::live_caption::LiveCaptionManager;

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
    import_recording_file_inner(
        &app_handle,
        &pool,
        &meeting_id,
        &source_path,
        Some(file_name.as_str()),
        original_file_name.as_deref(),
        duration_seconds,
    )
    .await
}

#[tauri::command]
pub async fn import_recording_files(
    meeting_id: String,
    items: Vec<RecordingImportItem>,
    app_handle: AppHandle,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<RecordingImportBatchResult, String> {
    let _guard = data_lock.try_begin_write()?;
    let mut results = Vec::with_capacity(items.len());

    for item in items {
        let original_file_name = item.original_file_name.clone();
        let result = import_recording_file_inner(
            &app_handle,
            &pool,
            &meeting_id,
            &item.source_path,
            original_file_name.as_deref(),
            original_file_name.as_deref(),
            None,
        )
        .await;
        results.push(match result {
            Ok(recording) => RecordingImportItemResult {
                source_path: item.source_path,
                original_file_name,
                recording: Some(recording),
                error: None,
            },
            Err(error) => RecordingImportItemResult {
                source_path: item.source_path,
                original_file_name,
                recording: None,
                error: Some(error),
            },
        });
    }

    let success_count = results
        .iter()
        .filter(|result| result.recording.is_some())
        .count();
    Ok(RecordingImportBatchResult {
        failure_count: results.len() - success_count,
        success_count,
        results,
    })
}

async fn import_recording_file_inner(
    app_handle: &AppHandle,
    pool: &SqlitePool,
    meeting_id: &str,
    source_path: &str,
    extension_name: Option<&str>,
    original_file_name: Option<&str>,
    duration_seconds: Option<i64>,
) -> Result<Recording, String> {
    let source = PathBuf::from(source_path);
    validate_source_file(&source)?;
    let recordings_dir =
        resolve_recordings_dir(app_handle).map_err(|e| format!("無法取得錄音目錄：{e}"))?;
    let destination = recordings_dir.join(generate_recording_file_name(meeting_id, extension_name));
    let destination_for_copy = destination.clone();
    let source_for_copy = source.clone();

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&recordings_dir).map_err(|e| format!("無法建立錄音目錄：{e}"))?;
        std::fs::copy(&source_for_copy, &destination_for_copy)
            .map_err(|e| format!("複製音訊檔失敗：{e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("複製音訊檔工作失敗：{e}"))??;

    let file_path = destination.to_string_lossy().to_string();
    match recording::create_recording(
        pool,
        meeting_id,
        Some(&file_path),
        original_file_name,
        duration_seconds,
        None,
    )
    .await
    {
        Ok(recording) => Ok(recording),
        Err(error) => {
            let cleanup_error = tauri::async_runtime::spawn_blocking({
                let destination = destination.clone();
                move || std::fs::remove_file(destination)
            })
            .await
            .map_err(|join_error| format!("資料庫建立錄音失敗，且清理目的檔工作失敗：{join_error}"))
            .and_then(|result| {
                result.map_err(|cleanup_error| {
                    format!("資料庫建立錄音失敗，且清理目的檔失敗：{cleanup_error}")
                })
            });
            match cleanup_error {
                Ok(()) => Err(format!("建立錄音資料失敗：{error}")),
                Err(cleanup_error) => Err(cleanup_error),
            }
        }
    }
}

fn validate_source_file(source: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err("來源音訊檔不存在".into());
    }
    if !source.is_file() {
        return Err("來源音訊路徑不是一般檔案".into());
    }
    Ok(())
}

fn generate_recording_file_name(meeting_id: &str, extension_name: Option<&str>) -> String {
    let extension = extension_name
        .and_then(|name| Path::new(name).extension())
        .map(|value| value.to_string_lossy().to_string());
    match extension {
        Some(extension) if !extension.is_empty() => {
            format!("{meeting_id}_{}.{}", uuid::Uuid::new_v4(), extension)
        }
        _ => format!("{meeting_id}_{}", uuid::Uuid::new_v4()),
    }
}

#[cfg(test)]
mod tests {
    use super::{generate_recording_file_name, validate_source_file};
    use std::path::Path;

    #[test]
    fn purpose_file_names_are_unique_and_preserve_extension_case() {
        let first = generate_recording_file_name("meeting", Some("audio.MP3"));
        let second = generate_recording_file_name("meeting", Some("audio.MP3"));
        assert_ne!(first, second);
        assert!(first.ends_with(".MP3"));
        assert!(second.ends_with(".MP3"));
    }

    #[test]
    fn purpose_file_names_support_missing_extension() {
        assert!(!generate_recording_file_name("meeting", None).contains('.'));
        assert!(!generate_recording_file_name("meeting", Some("audio")).contains('.'));
    }

    #[test]
    fn missing_source_is_rejected() {
        let result = validate_source_file(Path::new("missing-recording-file.wav"));
        assert_eq!(result, Err("來源音訊檔不存在".to_string()));
    }
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
    live_caption_manager: State<'_, LiveCaptionManager>,
) -> Result<(), String> {
    if live_caption_manager.status().active {
        return Err("目前有即時字幕進行中，無法開始桌面錄音".into());
    }
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
        std::fs::rename(&temp_path, &final_path_for_move)
            .or_else(|_| {
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
