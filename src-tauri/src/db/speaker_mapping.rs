use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::SpeakerMapping;

pub async fn get_speaker_mappings(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<Vec<SpeakerMapping>> {
    let rows = sqlx::query_as::<_, SpeakerMapping>(
        "SELECT id, meeting_id, recording_id, speaker_label, participant_name, created_at, updated_at
         FROM recording_speaker_mappings
         WHERE meeting_id = ?
         ORDER BY recording_id ASC, speaker_label ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

pub async fn upsert_speaker_mapping(
    pool: &SqlitePool,
    meeting_id: &str,
    recording_id: &str,
    speaker_label: &str,
    participant_name: &str,
) -> Result<SpeakerMapping> {
    let recording_id = recording_id.trim();
    let speaker_label = speaker_label.trim();
    let participant_name = participant_name.trim();

    if recording_id.is_empty() {
        return Err(anyhow::anyhow!("錄音 ID 不可為空"));
    }

    if speaker_label.is_empty() {
        return Err(anyhow::anyhow!("講者標籤不可為空"));
    }

    if participant_name.is_empty() {
        return Err(anyhow::anyhow!("參與者姓名不可為空"));
    }

    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO recording_speaker_mappings (
            id, meeting_id, recording_id, speaker_label, participant_name, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(recording_id, speaker_label)
         DO UPDATE SET participant_name = excluded.participant_name, updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(meeting_id)
    .bind(recording_id)
    .bind(speaker_label)
    .bind(participant_name)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    get_speaker_mapping(pool, meeting_id, recording_id, speaker_label)
        .await?
        .ok_or_else(|| anyhow::anyhow!("講者對應儲存後無法取得"))
}

pub async fn delete_speaker_mapping(
    pool: &SqlitePool,
    meeting_id: &str,
    recording_id: &str,
    speaker_label: &str,
) -> Result<()> {
    sqlx::query(
        "DELETE FROM recording_speaker_mappings
         WHERE meeting_id = ? AND recording_id = ? AND speaker_label = ?",
    )
    .bind(meeting_id)
    .bind(recording_id.trim())
    .bind(speaker_label.trim())
    .execute(pool)
    .await?;

    Ok(())
}

async fn get_speaker_mapping(
    pool: &SqlitePool,
    meeting_id: &str,
    recording_id: &str,
    speaker_label: &str,
) -> Result<Option<SpeakerMapping>> {
    let row = sqlx::query_as::<_, SpeakerMapping>(
        "SELECT id, meeting_id, recording_id, speaker_label, participant_name, created_at, updated_at
         FROM recording_speaker_mappings
         WHERE meeting_id = ? AND recording_id = ? AND speaker_label = ?",
    )
    .bind(meeting_id)
    .bind(recording_id)
    .bind(speaker_label)
    .fetch_optional(pool)
    .await?;

    Ok(row)
}
