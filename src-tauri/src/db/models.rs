use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingWithDetails {
    pub id: String,
    pub title: String,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub participants: Vec<String>,
    pub has_transcript: bool,
    pub has_summary: bool,
    pub tags: Vec<Tag>,
    pub meeting_date: Option<String>,
    pub archived_at: Option<String>,
    pub archived_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SpeakerMapping {
    pub id: String,
    pub meeting_id: String,
    pub recording_id: Option<String>,
    pub speaker_label: String,
    pub participant_name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Transcript {
    pub id: String,
    pub meeting_id: String,
    pub original_content: Option<String>,
    pub proofread_content: Option<String>,
    pub proofread_status: String,
    pub proofread_error: Option<String>,
    pub proofread_warning: Option<String>,
    pub proofread_started_at: Option<String>,
    pub manual_content: Option<String>,
    pub manual_base_version: Option<String>,
    pub manual_updated_at: Option<String>,
    pub active_version: String,
    pub proofread_provider: Option<String>,
    pub proofread_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Summary {
    pub id: String,
    pub meeting_id: String,
    pub content: String,
    pub provider: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Recording {
    pub id: String,
    pub meeting_id: String,
    pub file_path: Option<String>,
    pub original_file_name: Option<String>,
    pub duration_seconds: Option<i64>,
    pub source_mode: Option<String>,
    pub sort_order: i64,
    pub segment_transcript: Option<String>,
    pub segment_proofread: Option<String>,
    pub diarization_degraded: i64,
    pub no_break_before: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingImportItem {
    pub source_path: String,
    pub original_file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingImportItemResult {
    pub source_path: String,
    pub original_file_name: Option<String>,
    pub recording: Option<Recording>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingImportBatchResult {
    pub results: Vec<RecordingImportItemResult>,
    pub success_count: usize,
    pub failure_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct SavedParticipant {
    pub id: String,
    pub name: String,
    pub usage_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeetingTemplate {
    pub id: String,
    pub name: String,
    pub title: String,
    pub category_id: Option<String>,
    pub participants: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTemplateRequest {
    pub name: String,
    pub title: String,
    pub category_id: Option<String>,
    pub participants: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTemplateRequest {
    pub name: String,
    pub title: String,
    pub participants: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMeetingRequest {
    pub title: String,
    pub category_id: Option<String>,
    pub participants: Vec<String>,
    pub tag_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateMeetingRequest {
    pub title: String,
    pub category_id: Option<String>,
    pub participants: Vec<String>,
    pub tag_ids: Option<Vec<String>>,
    pub meeting_date: Option<String>,
}

/// 繫結至 `saved_participants` 的聲紋記錄，經使用者確認講者對應時寫入。
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Voiceprint {
    pub id: String,
    pub participant_id: String,
    pub model: String,
    /// f32 向量的 JSON 陣列序列化（見 `db::voiceprint` 模組註解）
    pub vector: String,
    pub created_at: String,
}

/// 錄音段落層級的講者嵌入向量暫存，供使用者確認講者對應前的段落內合併與
/// 會議內串接比對使用。
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSpeakerEmbedding {
    pub id: String,
    pub meeting_id: String,
    pub recording_id: String,
    pub speaker_label: String,
    pub model: String,
    pub vector: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: String,
}
