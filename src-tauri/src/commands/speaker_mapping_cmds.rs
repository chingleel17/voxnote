use sqlx::SqlitePool;
use tauri::State;

use crate::{backup::DataOperationLock, db::{models::SpeakerMapping, speaker_mapping}};

#[tauri::command]
pub async fn get_speaker_mappings(
    meeting_id: String,
    pool: State<'_, SqlitePool>,
) -> Result<Vec<SpeakerMapping>, String> {
    speaker_mapping::get_speaker_mappings(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upsert_speaker_mapping(
    meeting_id: String,
    recording_id: String,
    speaker_label: String,
    participant_name: String,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<SpeakerMapping, String> {
    let _guard = data_lock.try_begin_write()?;
    speaker_mapping::upsert_speaker_mapping(
        &pool,
        &meeting_id,
        &recording_id,
        &speaker_label,
        &participant_name,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_speaker_mapping(
    meeting_id: String,
    recording_id: String,
    speaker_label: String,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<(), String> {
    let _guard = data_lock.try_begin_write()?;
    speaker_mapping::delete_speaker_mapping(&pool, &meeting_id, &recording_id, &speaker_label)
        .await
        .map_err(|e| e.to_string())
}
