use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use crate::db::{models::Recording, recording, transcript};

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
    duration_seconds: Option<i64>,
    pool: State<'_, SqlitePool>,
) -> Result<Recording, String> {
    recording::create_recording(&pool, &meeting_id, Some(&file_path), duration_seconds)
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

    recording::create_recording(&pool, &meeting_id, Some(&file_path_str), duration_seconds)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_recording(
    recording_id: String,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    recording::delete_recording(&pool, &recording_id)
        .await
        .map_err(|e| e.to_string())
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

    let merged = recording::get_segment_transcripts_with_break(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())
        .map(|segments| recording::merge_segment_texts(&segments))?;

    if !merged.is_empty() {
        transcript::upsert_transcript_original(&pool, &meeting_id, &merged)
            .await
            .map_err(|e| e.to_string())?;
    }

    if let Some(proofread_merged) = recording::get_merged_proofread_text(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?
    {
        let provider = transcript::get_transcript(&pool, &meeting_id)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|item| item.proofread_provider)
            .unwrap_or_else(|| "segment-proofread".to_string());

        transcript::update_proofread(&pool, &meeting_id, &proofread_merged, &provider)
            .await
            .map_err(|e| e.to_string())?;
    }

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

    // 僅在有內容時才更新，避免覆蓋已有的逐字稿
    if !merged.is_empty() {
        transcript::upsert_transcript_original(&pool, &meeting_id, &merged)
            .await
            .map_err(|e| e.to_string())?;
    }

    if let Some(proofread_merged) = recording::get_merged_proofread_text(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?
    {
        let provider = transcript::get_transcript(&pool, &meeting_id)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|item| item.proofread_provider)
            .unwrap_or_else(|| "segment-proofread".to_string());

        transcript::update_proofread(&pool, &meeting_id, &proofread_merged, &provider)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(merged)
}
