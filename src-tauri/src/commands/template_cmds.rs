use sqlx::SqlitePool;
use tauri::State;

use crate::db::{
    meeting_template,
    models::{CreateTemplateRequest, MeetingTemplate, SavedParticipant, UpdateTemplateRequest},
    saved_participant,
};

#[tauri::command]
pub async fn get_saved_participants(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<SavedParticipant>, String> {
    saved_participant::get_saved_participants(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upsert_saved_participant(
    name: String,
    pool: State<'_, SqlitePool>,
) -> Result<SavedParticipant, String> {
    saved_participant::upsert_saved_participant(&pool, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_saved_participant(
    id: String,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    saved_participant::delete_saved_participant(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_saved_participant(
    id: String,
    name: String,
    pool: State<'_, SqlitePool>,
) -> Result<SavedParticipant, String> {
    saved_participant::update_saved_participant(&pool, &id, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_meeting_templates(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<MeetingTemplate>, String> {
    meeting_template::get_templates(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_meeting_template(
    request: CreateTemplateRequest,
    pool: State<'_, SqlitePool>,
) -> Result<MeetingTemplate, String> {
    meeting_template::create_template(&pool, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_meeting_template(
    id: String,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    meeting_template::delete_template(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_meeting_template(
    id: String,
    request: UpdateTemplateRequest,
    pool: State<'_, SqlitePool>,
) -> Result<MeetingTemplate, String> {
    meeting_template::update_template(&pool, &id, request)
        .await
        .map_err(|e| e.to_string())
}
