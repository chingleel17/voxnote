use anyhow::Result;
use chrono::Utc;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use super::models::{CreateTemplateRequest, MeetingTemplate};

fn row_to_template(row: &sqlx::sqlite::SqliteRow) -> MeetingTemplate {
    let participants_json: String = row.try_get("participants_json").unwrap_or_default();
    let participants: Vec<String> =
        serde_json::from_str(&participants_json).unwrap_or_default();
    MeetingTemplate {
        id: row.get("id"),
        name: row.get("name"),
        title: row.get("title"),
        category_id: row.get("category_id"),
        participants,
        created_at: row.get("created_at"),
    }
}

pub async fn get_templates(pool: &SqlitePool) -> Result<Vec<MeetingTemplate>> {
    let rows = sqlx::query(
        "SELECT id, name, title, category_id, participants_json, created_at FROM meeting_templates ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_template).collect())
}

pub async fn create_template(
    pool: &SqlitePool,
    req: CreateTemplateRequest,
) -> Result<MeetingTemplate> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let participants_json = serde_json::to_string(&req.participants)?;

    sqlx::query(
        "INSERT INTO meeting_templates (id, name, title, category_id, participants_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&req.name)
    .bind(&req.title)
    .bind(&req.category_id)
    .bind(&participants_json)
    .bind(&now)
    .execute(pool)
    .await?;

    let row = sqlx::query(
        "SELECT id, name, title, category_id, participants_json, created_at FROM meeting_templates WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool)
    .await?;
    Ok(row_to_template(&row))
}

pub async fn delete_template(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM meeting_templates WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
