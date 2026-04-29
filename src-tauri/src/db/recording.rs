use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::Recording;

pub async fn get_recording(pool: &SqlitePool, meeting_id: &str) -> Result<Option<Recording>> {
    let row = sqlx::query_as::<_, Recording>(
        "SELECT id, meeting_id, file_path, duration_seconds, created_at FROM recordings WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn upsert_recording(
    pool: &SqlitePool,
    meeting_id: &str,
    file_path: Option<&str>,
    duration_seconds: Option<i64>,
) -> Result<Recording> {
    let now = Utc::now().to_rfc3339();
    let existing = get_recording(pool, meeting_id).await?;

    if let Some(existing) = existing {
        sqlx::query(
            "UPDATE recordings SET file_path = ?, duration_seconds = ? WHERE id = ?",
        )
        .bind(file_path)
        .bind(duration_seconds)
        .bind(&existing.id)
        .execute(pool)
        .await?;
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO recordings (id, meeting_id, file_path, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(file_path)
        .bind(duration_seconds)
        .bind(&now)
        .execute(pool)
        .await?;
    }

    get_recording(pool, meeting_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("錄音 upsert 後無法取得"))
}
