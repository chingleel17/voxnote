use sqlx::SqlitePool;
use tauri::State;

use crate::db::{models::SpeakerMapping, speaker_mapping};

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
    speaker_label: String,
    participant_name: String,
    pool: State<'_, SqlitePool>,
) -> Result<SpeakerMapping, String> {
    speaker_mapping::upsert_speaker_mapping(&pool, &meeting_id, &speaker_label, &participant_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_speaker_mapping(
    meeting_id: String,
    speaker_label: String,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    speaker_mapping::delete_speaker_mapping(&pool, &meeting_id, &speaker_label)
        .await
        .map_err(|e| e.to_string())
}
