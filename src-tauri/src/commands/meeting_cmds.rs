use sqlx::SqlitePool;
use tauri::State;

use crate::db::{
    category, meeting,
    models::{Category, CreateMeetingRequest, MeetingWithDetails, UpdateMeetingRequest},
};

#[tauri::command]
pub async fn get_meetings(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<MeetingWithDetails>, String> {
    meeting::get_meetings(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_meeting(
    id: String,
    pool: State<'_, SqlitePool>,
) -> Result<Option<MeetingWithDetails>, String> {
    meeting::get_meeting(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_meeting(
    request: CreateMeetingRequest,
    pool: State<'_, SqlitePool>,
) -> Result<MeetingWithDetails, String> {
    meeting::create_meeting(&pool, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_meeting(
    id: String,
    request: UpdateMeetingRequest,
    pool: State<'_, SqlitePool>,
) -> Result<MeetingWithDetails, String> {
    meeting::update_meeting(&pool, &id, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_meeting(
    id: String,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    meeting::delete_meeting(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_categories(pool: State<'_, SqlitePool>) -> Result<Vec<Category>, String> {
    category::get_categories(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_category(
    name: String,
    pool: State<'_, SqlitePool>,
) -> Result<Category, String> {
    category::create_category(&pool, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_category(
    id: String,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    category::delete_category(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}
