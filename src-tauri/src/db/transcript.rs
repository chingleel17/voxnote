use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::{models::Transcript, recording};

pub async fn get_transcript(pool: &SqlitePool, meeting_id: &str) -> Result<Option<Transcript>> {
    let row = sqlx::query_as::<_, Transcript>(
        "SELECT id, meeting_id, original_content, proofread_content, proofread_status, proofread_error, proofread_warning, proofread_started_at, manual_content, manual_base_version, manual_updated_at, active_version, proofread_provider, proofread_at, created_at, updated_at FROM transcripts WHERE meeting_id = ?",
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
            "INSERT INTO transcripts (id, meeting_id, original_content, proofread_status, active_version, created_at, updated_at) VALUES (?, ?, ?, 'idle', 'original', ?, ?)",
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
    warning: Option<&str>,
) -> Result<Transcript> {
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "UPDATE transcripts
         SET proofread_content = ?, proofread_status = 'completed', proofread_error = NULL, proofread_warning = ?, proofread_started_at = NULL,
             proofread_provider = ?, proofread_at = ?, updated_at = ?
         WHERE meeting_id = ?",
    )
    .bind(proofread_content)
    .bind(warning)
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
                id, meeting_id, original_content, proofread_content, proofread_status, proofread_error, proofread_warning, proofread_started_at, manual_content, manual_base_version, manual_updated_at,
                active_version, created_at, updated_at
            ) VALUES (?, ?, NULL, NULL, 'idle', NULL, NULL, NULL, ?, ?, ?, 'manual', ?, ?)",
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

    sqlx::query("UPDATE transcripts SET active_version = ?, updated_at = ? WHERE meeting_id = ?")
        .bind(version)
        .bind(&now)
        .bind(meeting_id)
        .execute(pool)
        .await?;

    get_transcript(pool, meeting_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("切換版本後無法取得逐字稿"))
}

pub async fn sync_generated_content_from_recordings(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<Option<Transcript>> {
    let merged_original = recording::get_segment_transcripts_with_break(pool, meeting_id)
        .await
        .map(|segments| recording::merge_segment_texts(&segments))?;
    let merged_original = (!merged_original.is_empty()).then_some(merged_original);
    let merged_proofread = recording::get_merged_proofread_text(pool, meeting_id).await?;
    let now = Utc::now().to_rfc3339();

    match get_transcript(pool, meeting_id).await? {
        Some(existing) => {
            // 決定最終的 proofread 內容優先順序：
            // 1. segment-level proofread 存在 → 使用合併結果
            // 2. 已有整份逐字稿的校稿結果（status = completed）→ 保留，不覆蓋
            // 3. 其他 → 清除為 idle
            let (
                final_proofread_content,
                final_proofread_status,
                final_proofread_warning,
                final_proofread_provider,
                final_proofread_at,
            ): (Option<&str>, &str, Option<&str>, Option<&str>, Option<&str>) =
                if merged_proofread.is_some() {
                    (
                        merged_proofread.as_deref(),
                        "completed",
                        existing.proofread_warning.as_deref(),
                        Some(
                            existing
                                .proofread_provider
                                .as_deref()
                                .unwrap_or("segment-proofread"),
                        ),
                        Some(now.as_str()),
                    )
                } else if existing.proofread_status == "completed"
                    && existing.proofread_content.is_some()
                {
                    // 整份逐字稿校稿結果存在，重新轉譯時保留不覆蓋
                    (
                        existing.proofread_content.as_deref(),
                        "completed",
                        existing.proofread_warning.as_deref(),
                        existing.proofread_provider.as_deref(),
                        existing.proofread_at.as_deref(),
                    )
                } else {
                    (None, "idle", None, None, None)
                };

            let active_version = resolve_active_version(
                &existing.active_version,
                existing.manual_content.as_deref(),
                merged_original.is_some(),
                final_proofread_status == "completed",
            );

            sqlx::query(
                "UPDATE transcripts
                 SET original_content = ?, proofread_content = ?, proofread_status = ?, proofread_error = ?, proofread_warning = ?, proofread_started_at = ?,
                     proofread_provider = ?, proofread_at = ?, active_version = ?, updated_at = ?
                 WHERE meeting_id = ?",
            )
            .bind(merged_original.as_deref())
            .bind(final_proofread_content)
            .bind(final_proofread_status)
            .bind::<Option<&str>>(None)
            .bind(final_proofread_warning)
            .bind::<Option<&str>>(None)
            .bind(final_proofread_provider)
            .bind(final_proofread_at)
            .bind(active_version)
            .bind(&now)
            .bind(meeting_id)
            .execute(pool)
            .await?;

            get_transcript(pool, meeting_id).await
        }
        None => {
            if merged_original.is_none() && merged_proofread.is_none() {
                return Ok(None);
            }

            let id = Uuid::new_v4().to_string();
            let proofread_provider = merged_proofread.as_ref().map(|_| "segment-proofread");
            let proofread_at = merged_proofread.as_ref().map(|_| now.as_str());

            sqlx::query(
                "INSERT INTO transcripts (
                    id, meeting_id, original_content, proofread_content, proofread_status, proofread_error, proofread_warning, proofread_started_at,
                    active_version, proofread_provider, proofread_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'original', ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(meeting_id)
            .bind(merged_original.as_deref())
            .bind(merged_proofread.as_deref())
            .bind(if merged_proofread.is_some() { "completed" } else { "idle" })
            .bind(proofread_provider)
            .bind(proofread_at)
            .bind(&now)
            .bind(&now)
            .execute(pool)
            .await?;

            get_transcript(pool, meeting_id).await
        }
    }
}

fn resolve_active_version(
    current_version: &str,
    manual_content: Option<&str>,
    has_original: bool,
    has_proofread: bool,
) -> &'static str {
    let has_manual = manual_content.is_some_and(|content| !content.is_empty());

    match current_version {
        "manual" if has_manual => "manual",
        "proofread" if has_proofread => "proofread",
        "original" if has_original => "original",
        _ if has_original => "original",
        _ if has_proofread => "proofread",
        _ if has_manual => "manual",
        _ => "original",
    }
}

pub async fn mark_proofread_running(pool: &SqlitePool, meeting_id: &str) -> Result<Transcript> {
    let now = Utc::now().to_rfc3339();
    let existing = get_transcript(pool, meeting_id).await?;

    if existing.is_some() {
        sqlx::query(
            "UPDATE transcripts
             SET proofread_status = 'running', proofread_error = NULL, proofread_warning = NULL, proofread_started_at = ?, updated_at = ?
             WHERE meeting_id = ?",
        )
        .bind(&now)
        .bind(&now)
        .bind(meeting_id)
        .execute(pool)
        .await?;
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO transcripts (
                id, meeting_id, original_content, proofread_content, proofread_status, proofread_error, proofread_warning, proofread_started_at,
                active_version, created_at, updated_at
            ) VALUES (?, ?, NULL, NULL, 'running', NULL, NULL, ?, 'original', ?, ?)",
        )
        .bind(&id)
        .bind(meeting_id)
        .bind(&now)
        .bind(&now)
        .bind(&now)
        .execute(pool)
        .await?;
    }

    get_transcript(pool, meeting_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("校稿啟動後無法取得逐字稿"))
}

pub async fn mark_proofread_failed(
    pool: &SqlitePool,
    meeting_id: &str,
    error: &str,
) -> Result<Transcript> {
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "UPDATE transcripts
         SET proofread_status = 'failed', proofread_error = ?, proofread_warning = NULL, proofread_started_at = NULL, updated_at = ?
         WHERE meeting_id = ?",
    )
    .bind(error)
    .bind(&now)
    .bind(meeting_id)
    .execute(pool)
    .await?;

    get_transcript(pool, meeting_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("校稿失敗後無法取得逐字稿"))
}

pub async fn recover_interrupted_proofreads(pool: &SqlitePool) -> Result<()> {
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "UPDATE transcripts
         SET proofread_status = 'interrupted',
             proofread_error = '校稿在應用程式關閉或中斷後未完成，請重新觸發。',
             proofread_warning = NULL,
             proofread_started_at = NULL,
             updated_at = ?
         WHERE proofread_status = 'running'",
    )
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(())
}
