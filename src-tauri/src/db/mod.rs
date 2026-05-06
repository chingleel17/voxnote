use anyhow::Result;
use sqlx::SqlitePool;
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
    sort_order INTEGER NOT NULL DEFAULT 0,
    segment_transcript TEXT,
    segment_proofread TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS saved_participants (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
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
"#;

pub async fn init_db(app: &AppHandle) -> Result<SqlitePool> {
    use tauri::Manager;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("無法取得 AppData 目錄：{}", e))?;

    std::fs::create_dir_all(&data_dir)?;

    let db_path = data_dir.join("voxnote.db");
    let db_url = format!(
        "sqlite:///{}?mode=rwc",
        db_path.to_string_lossy().replace('\\', "/")
    );

    let pool = SqlitePool::connect(&db_url).await?;

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
    let _ = sqlx::query("ALTER TABLE recordings ADD COLUMN segment_transcript TEXT")
        .execute(&pool)
        .await;
    let _ = sqlx::query("ALTER TABLE recordings ADD COLUMN segment_proofread TEXT")
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

    transcript::recover_interrupted_proofreads(&pool).await?;

    Ok(pool)
}
