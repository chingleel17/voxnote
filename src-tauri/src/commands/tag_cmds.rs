use sqlx::SqlitePool;
use tauri::State;

use crate::db::{models::Tag, tag};

#[tauri::command]
pub async fn get_tags(pool: State<'_, SqlitePool>) -> Result<Vec<Tag>, String> {
    tag::get_tags(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_tag(
    name: String,
    color: String,
    pool: State<'_, SqlitePool>,
) -> Result<Tag, String> {
    tag::create_tag(&pool, &name, &color)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_tag(
    id: String,
    name: String,
    color: String,
    pool: State<'_, SqlitePool>,
) -> Result<Tag, String> {
    tag::update_tag(&pool, &id, &name, &color)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_tag(id: String, pool: State<'_, SqlitePool>) -> Result<(), String> {
    tag::delete_tag(&pool, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_meeting_tags(
    meeting_id: String,
    tag_ids: Vec<String>,
    pool: State<'_, SqlitePool>,
) -> Result<(), String> {
    tag::set_meeting_tags(&pool, &meeting_id, &tag_ids)
        .await
        .map_err(|e| e.to_string())
}
