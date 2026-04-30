use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::SavedParticipant;

pub async fn get_saved_participants(pool: &SqlitePool) -> Result<Vec<SavedParticipant>> {
    let rows = sqlx::query_as::<_, SavedParticipant>(
        "SELECT id, name, usage_count, created_at FROM saved_participants ORDER BY usage_count DESC, name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// 若名稱已存在則累加 usage_count，否則新增
pub async fn upsert_saved_participant(pool: &SqlitePool, name: &str) -> Result<SavedParticipant> {
    let existing = sqlx::query_as::<_, SavedParticipant>(
        "SELECT id, name, usage_count, created_at FROM saved_participants WHERE name = ?",
    )
    .bind(name)
    .fetch_optional(pool)
    .await?;

    if let Some(existing) = existing {
        sqlx::query("UPDATE saved_participants SET usage_count = usage_count + 1 WHERE id = ?")
            .bind(&existing.id)
            .execute(pool)
            .await?;
        let updated = sqlx::query_as::<_, SavedParticipant>(
            "SELECT id, name, usage_count, created_at FROM saved_participants WHERE id = ?",
        )
        .bind(&existing.id)
        .fetch_one(pool)
        .await?;
        return Ok(updated);
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO saved_participants (id, name, usage_count, created_at) VALUES (?, ?, 1, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(&now)
    .execute(pool)
    .await?;

    let created = sqlx::query_as::<_, SavedParticipant>(
        "SELECT id, name, usage_count, created_at FROM saved_participants WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool)
    .await?;
    Ok(created)
}

pub async fn delete_saved_participant(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM saved_participants WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
