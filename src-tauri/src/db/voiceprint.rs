use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::{RecordingSpeakerEmbedding, Voiceprint};

/// 序列化 f32 向量為 JSON 陣列文字，供 TEXT 欄位儲存。與 `deserialize_vector`
/// 讀寫格式須保持一致；backup.rs 對聲紋相關表採一般文字欄位複製，故選用 JSON
/// TEXT 而非 BLOB，可原樣隨備份合併流程保留。
pub fn serialize_vector(vector: &[f32]) -> String {
    serde_json::to_string(vector).unwrap_or_else(|_| "[]".to_string())
}

pub fn deserialize_vector(vector: &str) -> Vec<f32> {
    serde_json::from_str(vector).unwrap_or_default()
}

// ---- voiceprints（繫結 saved_participants，經使用者確認後寫入） ----

pub async fn insert_voiceprint(
    pool: &SqlitePool,
    participant_id: &str,
    model: &str,
    vector: &[f32],
) -> Result<Voiceprint> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let vector_text = serialize_vector(vector);

    sqlx::query(
        "INSERT INTO voiceprints (id, participant_id, model, vector, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(participant_id)
    .bind(model)
    .bind(&vector_text)
    .bind(&now)
    .execute(pool)
    .await?;

    let created = sqlx::query_as::<_, Voiceprint>(
        "SELECT id, participant_id, model, vector, created_at FROM voiceprints WHERE id = ?",
    )
    .bind(&id)
    .fetch_one(pool)
    .await?;
    Ok(created)
}

/// 取得指定模型下的所有聲紋，供跨會議比對；模型不符者 MUST NOT 納入。
pub async fn get_voiceprints_by_model(pool: &SqlitePool, model: &str) -> Result<Vec<Voiceprint>> {
    let rows = sqlx::query_as::<_, Voiceprint>(
        "SELECT id, participant_id, model, vector, created_at FROM voiceprints WHERE model = ?",
    )
    .bind(model)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_voiceprints_by_participant(
    pool: &SqlitePool,
    participant_id: &str,
) -> Result<()> {
    sqlx::query("DELETE FROM voiceprints WHERE participant_id = ?")
        .bind(participant_id)
        .execute(pool)
        .await?;
    Ok(())
}

// ---- recording_speaker_embeddings（轉錄完成即寫入的暫存層） ----

/// 轉錄完成且附有向量時 upsert；不需使用者確認即可寫入，供段落內合併與
/// 會議內串接比對使用（見 design 決策 2.1）。
pub async fn upsert_recording_speaker_embedding(
    pool: &SqlitePool,
    meeting_id: &str,
    recording_id: &str,
    speaker_label: &str,
    model: &str,
    vector: &[f32],
) -> Result<()> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let vector_text = serialize_vector(vector);

    sqlx::query(
        "INSERT INTO recording_speaker_embeddings (
            id, meeting_id, recording_id, speaker_label, model, vector, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(recording_id, speaker_label)
         DO UPDATE SET model = excluded.model, vector = excluded.vector, created_at = excluded.created_at",
    )
    .bind(&id)
    .bind(meeting_id)
    .bind(recording_id)
    .bind(speaker_label)
    .bind(model)
    .bind(&vector_text)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_recording_speaker_embeddings_by_recording(
    pool: &SqlitePool,
    recording_id: &str,
) -> Result<Vec<RecordingSpeakerEmbedding>> {
    let rows = sqlx::query_as::<_, RecordingSpeakerEmbedding>(
        "SELECT id, meeting_id, recording_id, speaker_label, model, vector, created_at
         FROM recording_speaker_embeddings
         WHERE recording_id = ?
         ORDER BY speaker_label ASC",
    )
    .bind(recording_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// 取得同一會議所有錄音段落的講者向量，供跨錄音段落串接比對使用。
pub async fn get_recording_speaker_embeddings_by_meeting(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<Vec<RecordingSpeakerEmbedding>> {
    let rows = sqlx::query_as::<_, RecordingSpeakerEmbedding>(
        "SELECT id, meeting_id, recording_id, speaker_label, model, vector, created_at
         FROM recording_speaker_embeddings
         WHERE meeting_id = ?
         ORDER BY recording_id ASC, speaker_label ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
