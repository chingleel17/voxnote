use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::Transcript;

pub async fn get_transcript(pool: &SqlitePool, meeting_id: &str) -> Result<Option<Transcript>> {
    let row = sqlx::query_as::<_, Transcript>(
        "SELECT id, meeting_id, original_content, proofread_content, active_version, proofread_provider, proofread_at, created_at, updated_at FROM transcripts WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn upsert_transcript_original(
    pool: &SqlitePool,
    meeting_id: &str,
    content: &str,
) -> Result<Transcript> {
    let now = Utc::now().to_rfc3339();
    let existing = get_transcript(pool, meeting_id).await?;

    if let Some(existing) = existing {
        if existing.original_content.is_none() {
            sqlx::query(
                "UPDATE transcripts SET original_content = ?, updated_at = ? WHERE meeting_id = ?",
            )
            .bind(content)
            .bind(&now)
            .bind(meeting_id)
            .execute(pool)
            .await?;
        }
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, original_content, active_version, created_at, updated_at) VALUES (?, ?, ?, 'original', ?, ?)",
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(content)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    }

    get_transcript(pool, meeting_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("逐字稿 upsert 後無法取得"))
}

pub async fn update_proofread(
    pool: &SqlitePool,
    meeting_id: &str,
    proofread_content: &str,
    provider: &str,
) -> Result<Transcript> {
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "UPDATE transcripts SET proofread_content = ?, proofread_provider = ?, proofread_at = ?, updated_at = ? WHERE meeting_id = ?",
    )
    .bind(proofread_content)
    .bind(provider)
    .bind(&now)
    .bind(&now)
    .bind(meeting_id)
    .execute(pool)
    .await?;

    get_transcript(pool, meeting_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("校稿更新後無法取得"))
}

pub async fn switch_version(
    pool: &SqlitePool,
    meeting_id: &str,
    version: &str,
) -> Result<Transcript> {
    if version != "original" && version != "proofread" {
        return Err(anyhow::anyhow!(
            "版本必須是 'original' 或 'proofread'，收到：{}",
            version
        ));
    }

    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "UPDATE transcripts SET active_version = ?, updated_at = ? WHERE meeting_id = ?",
    )
    .bind(version)
    .bind(&now)
    .bind(meeting_id)
    .execute(pool)
    .await?;

    get_transcript(pool, meeting_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("切換版本後無法取得逐字稿"))
}
