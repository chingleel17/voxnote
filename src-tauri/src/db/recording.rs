use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::Recording;

const SELECT_COLS: &str =
    "id, meeting_id, file_path, original_file_name, duration_seconds, sort_order, segment_transcript, segment_proofread, no_break_before, created_at";

pub async fn get_recording(pool: &SqlitePool, meeting_id: &str) -> Result<Option<Recording>> {
    let sql = format!("SELECT {SELECT_COLS} FROM recordings WHERE meeting_id = ? ORDER BY sort_order ASC, created_at ASC LIMIT 1");
    let row = sqlx::query_as::<_, Recording>(&sql)
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

pub async fn get_recordings(pool: &SqlitePool, meeting_id: &str) -> Result<Vec<Recording>> {
    let sql = format!("SELECT {SELECT_COLS} FROM recordings WHERE meeting_id = ? ORDER BY sort_order ASC, created_at ASC");
    let rows = sqlx::query_as::<_, Recording>(&sql)
        .bind(meeting_id)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// 永遠建立新錄音段落（不覆蓋舊的）
pub async fn create_recording(
    pool: &SqlitePool,
    meeting_id: &str,
    file_path: Option<&str>,
    original_file_name: Option<&str>,
    duration_seconds: Option<i64>,
) -> Result<Recording> {
    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();

    let next_sort_order: (Option<i64>,) =
        sqlx::query_as("SELECT MAX(sort_order) FROM recordings WHERE meeting_id = ?")
            .bind(meeting_id)
            .fetch_one(pool)
            .await?;
    let sort_order = next_sort_order.0.unwrap_or(-1) + 1;

    sqlx::query(
        "INSERT INTO recordings (id, meeting_id, file_path, original_file_name, duration_seconds, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(meeting_id)
    .bind(file_path)
    .bind(original_file_name)
    .bind(duration_seconds)
    .bind(sort_order)
    .bind(&now)
    .execute(pool)
    .await?;

    get_recording_by_id(pool, &id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("錄音建立後無法取得"))
}

pub async fn get_recording_by_id(pool: &SqlitePool, id: &str) -> Result<Option<Recording>> {
    let sql = format!("SELECT {SELECT_COLS} FROM recordings WHERE id = ?");
    let row = sqlx::query_as::<_, Recording>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

/// 更新段落的個別轉譯結果
pub async fn update_segment_transcript(
    pool: &SqlitePool,
    recording_id: &str,
    content: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE recordings SET segment_transcript = ?, segment_proofread = NULL WHERE id = ?",
    )
    .bind(content)
    .bind(recording_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn update_segment_proofread(
    pool: &SqlitePool,
    recording_id: &str,
    content: &str,
) -> Result<()> {
    sqlx::query("UPDATE recordings SET segment_proofread = ? WHERE id = ?")
        .bind(content)
        .bind(recording_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn clear_segment_proofreads_for_meeting(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<()> {
    sqlx::query("UPDATE recordings SET segment_proofread = NULL WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 刪除指定錄音段落，回傳所屬會議 ID（若存在）
pub async fn delete_recording(pool: &SqlitePool, recording_id: &str) -> Result<Option<String>> {
    let meeting_id: Option<String> =
        sqlx::query_scalar("SELECT meeting_id FROM recordings WHERE id = ?")
            .bind(recording_id)
            .fetch_optional(pool)
            .await?;

    sqlx::query("DELETE FROM recordings WHERE id = ?")
        .bind(recording_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM recording_speaker_mappings WHERE recording_id = ?")
        .bind(recording_id)
        .execute(pool)
        .await?;

    if let Some(meeting_id) = meeting_id {
        normalize_sort_orders(pool, &meeting_id).await?;
        return Ok(Some(meeting_id));
    }
    Ok(None)
}

/// 設定段落是否不加中場休息分隔符
pub async fn set_no_break_before(pool: &SqlitePool, recording_id: &str, value: bool) -> Result<()> {
    sqlx::query("UPDATE recordings SET no_break_before = ? WHERE id = ?")
        .bind(if value { 1i64 } else { 0i64 })
        .bind(recording_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// 取得所有已轉譯段落的文字與中場休息設定，依 sort_order 排序
pub async fn get_segment_transcripts_with_break(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<Vec<(String, bool)>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT segment_transcript, no_break_before FROM recordings WHERE meeting_id = ? AND segment_transcript IS NOT NULL ORDER BY sort_order ASC, created_at ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(t, nb)| (t, nb != 0)).collect())
}

pub async fn get_merged_proofread_text(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<Option<String>> {
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT segment_transcript, segment_proofread, no_break_before
         FROM recordings
         WHERE meeting_id = ? AND segment_transcript IS NOT NULL
         ORDER BY sort_order ASC, created_at ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await?;

    if rows.is_empty() {
        return Ok(None);
    }

    let has_any_proofread = rows.iter().any(|(_, proofread, _)| proofread.is_some());
    if !has_any_proofread {
        return Ok(None);
    }

    let merged_segments: Vec<(String, bool)> = rows
        .into_iter()
        .map(|(original, proofread, no_break_before)| {
            (proofread.unwrap_or(original), no_break_before != 0)
        })
        .collect();

    Ok(Some(merge_segment_texts(&merged_segments)))
}

pub async fn reorder_recordings(
    pool: &SqlitePool,
    meeting_id: &str,
    recording_ids: &[String],
) -> Result<Vec<Recording>> {
    let existing_ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM recordings WHERE meeting_id = ? ORDER BY sort_order ASC, created_at ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await?;

    if existing_ids.len() != recording_ids.len() {
        return Err(anyhow::anyhow!("錄音排序資料不完整"));
    }

    let mut expected = existing_ids.clone();
    let mut provided = recording_ids.to_vec();
    expected.sort();
    provided.sort();
    if expected != provided {
        return Err(anyhow::anyhow!("錄音排序資料與目前段落不一致"));
    }

    let mut tx = pool.begin().await?;
    for (index, recording_id) in recording_ids.iter().enumerate() {
        sqlx::query("UPDATE recordings SET sort_order = ? WHERE id = ? AND meeting_id = ?")
            .bind(index as i64)
            .bind(recording_id)
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    get_recordings(pool, meeting_id).await
}

async fn normalize_sort_orders(pool: &SqlitePool, meeting_id: &str) -> Result<()> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM recordings WHERE meeting_id = ? ORDER BY sort_order ASC, created_at ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await?;

    let mut tx = pool.begin().await?;
    for (index, recording_id) in ids.iter().enumerate() {
        sqlx::query("UPDATE recordings SET sort_order = ? WHERE id = ?")
            .bind(index as i64)
            .bind(recording_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 合併段落文字，no_break_before = true 的段落與前段直接相連
pub fn merge_segment_texts(segments: &[(String, bool)]) -> String {
    const BREAK_SEP: &str = "\n\n--- ☕ 中場休息 ---\n\n";
    match segments {
        [] => String::new(),
        [(text, _)] => text.clone(),
        _ => {
            let mut result = String::new();
            for (i, (text, no_break_before)) in segments.iter().enumerate() {
                if i > 0 {
                    result.push_str(if *no_break_before { "\n\n" } else { BREAK_SEP });
                }
                result.push_str(text);
            }
            result
        }
    }
}
