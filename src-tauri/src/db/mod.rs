use anyhow::Result;
use sqlx::SqlitePool;
use tauri::AppHandle;

pub mod category;
pub mod meeting;
pub mod models;
pub mod participant;
pub mod recording;
pub mod summary;
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

CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY,
    meeting_id TEXT UNIQUE NOT NULL,
    original_content TEXT,
    proofread_content TEXT,
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
    duration_seconds INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
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
    let db_url = format!("sqlite:///{}?mode=rwc", db_path.to_string_lossy().replace('\\', "/"));

    let pool = SqlitePool::connect(&db_url).await?;

    // 逐條執行 migration，忽略空白語句
    for statement in MIGRATION_SQL.split(';') {
        let trimmed = statement.trim();
        if !trimmed.is_empty() {
            sqlx::query(trimmed).execute(&pool).await?;
        }
    }

    Ok(pool)
}
