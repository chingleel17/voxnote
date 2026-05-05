use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::Transcript;

pub async fn get_transcript(pool: &SqlitePool, meeting_id: &str) -> Result<Option<Transcript>> {
    let row = sqlx::query_as::<_, Transcript>(
        "SELECT id, meeting_id, original_content, proofread_content, manual_content, manual_base_version, manual_updated_at, active_version, proofread_provider, proofread_at, created_at, updated_at FROM transcripts WHERE meeting_id = ?",
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

    if existing.is_some() {
        sqlx::query(
            "UPDATE transcripts SET original_content = ?, updated_at = ? WHERE meeting_id = ?",
        )
        .bind(content)
        .bind(&now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
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

pub async fn update_manual(
    pool: &SqlitePool,
    meeting_id: &str,
    manual_content: &str,
    base_version: &str,
) -> Result<Transcript> {
    if base_version != "original" && base_version != "proofread" {
        return Err(anyhow::anyhow!(
            "手動編輯來源版本必須是 'original' 或 'proofread'，收到：{}",
            base_version
        ));
    }

    let now = Utc::now().to_rfc3339();
    let existing = get_transcript(pool, meeting_id).await?;

    if existing.is_some() {
        sqlx::query(
            "UPDATE transcripts
             SET manual_content = ?, manual_base_version = ?, manual_updated_at = ?, active_version = 'manual', updated_at = ?
             WHERE meeting_id = ?",
        )
        .bind(manual_content)
        .bind(base_version)
        .bind(&now)
        .bind(&now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO transcripts (
                id, meeting_id, original_content, proofread_content, manual_content, manual_base_version, manual_updated_at,
                active_version, created_at, updated_at
            ) VALUES (?, ?, NULL, NULL, ?, ?, ?, 'manual', ?, ?)",
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(manual_content)
        .bind(base_version)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    }

    get_transcript(pool, meeting_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("手動編輯版更新後無法取得"))
}

pub async fn switch_version(
    pool: &SqlitePool,
    meeting_id: &str,
    version: &str,
) -> Result<Transcript> {
    if version != "original" && version != "proofread" && version != "manual" {
        return Err(anyhow::anyhow!(
            "版本必須是 'original'、'proofread' 或 'manual'，收到：{}",
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
