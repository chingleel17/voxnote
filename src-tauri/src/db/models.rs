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
    pub sort_order: i64,
    pub segment_transcript: Option<String>,
    pub segment_proofread: Option<String>,
    pub no_break_before: i64,
    pub created_at: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    pub created_at: String,
}
