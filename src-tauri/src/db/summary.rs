use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::Summary;

pub async fn get_summary(pool: &SqlitePool, meeting_id: &str) -> Result<Option<Summary>> {
    let row = sqlx::query_as::<_, Summary>(
        "SELECT id, meeting_id, content, provider, created_at FROM summaries WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn upsert_summary(
    pool: &SqlitePool,
    meeting_id: &str,
    content: &str,
    provider: &str,
) -> Result<Summary> {
    let now = Utc::now().to_rfc3339();
    let existing = get_summary(pool, meeting_id).await?;

    if let Some(existing) = existing {
        sqlx::query("UPDATE summaries SET content = ?, provider = ? WHERE id = ?")
            .bind(content)
            .bind(provider)
            .bind(&existing.id)
            .execute(pool)
            .await?;
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO summaries (id, meeting_id, content, provider, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(content)
        .bind(provider)
        .bind(&now)
        .execute(pool)
        .await?;
    }

    get_summary(pool, meeting_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("摘要 upsert 後無法取得"))
}
