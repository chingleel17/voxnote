use std::time::Duration;

use anyhow::Result;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    SqlitePool,
};
use tauri::AppHandle;

pub mod category;
pub mod meeting;
pub mod meeting_template;
pub mod models;
pub mod recording;
pub mod saved_participant;
pub mod speaker_mapping;
pub mod summary;
pub mod tag;
pub mod transcript;
pub mod voiceprint;

const MIGRATION_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category_id TEXT,
    archived_at TEXT,
    archived_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    name TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS speaker_mappings (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    speaker_label TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(meeting_id, speaker_label),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recording_speaker_mappings (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    recording_id TEXT NOT NULL,
    speaker_label TEXT NOT NULL,
    participant_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(recording_id, speaker_label),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY,
    meeting_id TEXT UNIQUE NOT NULL,
    original_content TEXT,
    proofread_content TEXT,
    proofread_status TEXT NOT NULL DEFAULT 'idle',
    proofread_error TEXT,
    proofread_warning TEXT,
    proofread_started_at TEXT,
    manual_content TEXT,
    manual_base_version TEXT,
    manual_updated_at TEXT,
    active_version TEXT NOT NULL DEFAULT 'original',
    proofread_provider TEXT,
    proofread_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    content TEXT NOT NULL,
    provider TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    file_path TEXT,
    original_file_name TEXT,
    duration_seconds INTEGER,
    source_mode TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    segment_transcript TEXT,
    segment_proofread TEXT,
    diarization_degraded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS saved_participants (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

-- 講者嵌入向量，繫結至 saved_participants（跨會議的全域參與者），供跨會議聲紋
-- 比對使用。一位參與者可累積多筆聲紋（見 add-speaker-voiceprint-matching design
-- 決策 4），故不對 participant_id 建唯一約束。model 欄位記錄產生向量的
-- diarization 模型識別，比對時 MUST 僅納入 model 相符者（模型變更後向量空間不可
-- 互比，見 design 決策 3）。vector 以 JSON 陣列（f32 列表）序列化為 TEXT，
-- 與 recording_speaker_embeddings 格式一致；backup.rs 對此表採一般文字欄位的
-- SELECT * 複製，無需特殊處理。
-- 注意：saved_participants 以 name 唯一，兩位同名參與者會共用聲紋記錄並產生
-- 混淆，此為既有資料模型的固有限制，本表不處理。
CREATE TABLE IF NOT EXISTS voiceprints (
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL,
    model TEXT NOT NULL,
    vector TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (participant_id) REFERENCES saved_participants(id) ON DELETE CASCADE
);

-- 錄音段落層級的講者嵌入向量暫存，供使用者確認講者對應前的段落內合併與會議內
-- 串接比對使用（此二層不需聲紋庫）。轉錄完成且附有向量時即寫入，不需使用者
-- 確認；使用者確認講者對應時，對應向量另外複製一份寫入 voiceprints 並繫結
-- saved_participants（見 add-speaker-voiceprint-matching design 決策 2.1）。
CREATE TABLE IF NOT EXISTS recording_speaker_embeddings (
    id TEXT PRIMARY KEY,
    meeting_id TEXT NOT NULL,
    recording_id TEXT NOT NULL,
    speaker_label TEXT NOT NULL,
    model TEXT NOT NULL,
    vector TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(recording_id, speaker_label),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meeting_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    category_id TEXT,
    participants_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    color TEXT NOT NULL DEFAULT '#6366f1',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_tags (
    meeting_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (meeting_id, tag_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_meetings_archived_created
    ON meetings(archived_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_participants_meeting_id
    ON participants(meeting_id);

CREATE INDEX IF NOT EXISTS idx_recordings_meeting_sort
    ON recordings(meeting_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS idx_summaries_meeting_id
    ON summaries(meeting_id);

CREATE INDEX IF NOT EXISTS idx_meeting_tags_tag_meeting
    ON meeting_tags(tag_id, meeting_id);

CREATE INDEX IF NOT EXISTS idx_voiceprints_participant_model
    ON voiceprints(participant_id, model);

CREATE INDEX IF NOT EXISTS idx_recording_speaker_embeddings_meeting
    ON recording_speaker_embeddings(meeting_id, model);
"#;

pub async fn init_db(app: &AppHandle) -> Result<SqlitePool> {
    use tauri::Manager;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("無法取得 AppData 目錄：{}", e))?;

    std::fs::create_dir_all(&data_dir)?;

    let db_path = data_dir.join("voxnote.db");
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .min_connections(1)
        .max_connections(5)
        .connect_with(options)
        .await?;

    // 逐條執行 migration，忽略空白語句
    for statement in MIGRATION_SQL.split(';') {
        let trimmed = statement.trim();
        if !trimmed.is_empty() {
            sqlx::query(trimmed).execute(&pool).await?;
        }
    }

    // 向下相容 ALTER TABLE（舊資料庫補欄位，重複欄位錯誤可忽略）
    let _ = sqlx::query("ALTER TABLE recordings ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE recordings ADD COLUMN original_file_name TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE recordings ADD COLUMN source_mode TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE recordings ADD COLUMN segment_transcript TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE recordings ADD COLUMN segment_proofread TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query(
        "ALTER TABLE recordings ADD COLUMN diarization_degraded INTEGER NOT NULL DEFAULT 0",
    )
    .execute(&pool)
    .await;
    let _ =
        sqlx::query("ALTER TABLE recordings ADD COLUMN no_break_before INTEGER NOT NULL DEFAULT 0")
            .execute(&pool)
            .await;
    let _ = sqlx::query("ALTER TABLE transcripts ADD COLUMN manual_content TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query(
        "ALTER TABLE transcripts ADD COLUMN proofread_status TEXT NOT NULL DEFAULT 'idle'",
    )
    .execute(&pool)
    .await;
    let _ = sqlx::query("ALTER TABLE transcripts ADD COLUMN proofread_error TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE transcripts ADD COLUMN proofread_warning TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE transcripts ADD COLUMN proofread_started_at TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE transcripts ADD COLUMN manual_base_version TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE transcripts ADD COLUMN manual_updated_at TEXT")
        .execute(&pool)
        .await;

    let _ = sqlx::query("ALTER TABLE meetings ADD COLUMN meeting_date TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE meetings ADD COLUMN archived_at TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE meetings ADD COLUMN archived_path TEXT")
        .execute(&pool)
        .await;

    transcript::recover_interrupted_proofreads(&pool).await?;

    Ok(pool)
}
