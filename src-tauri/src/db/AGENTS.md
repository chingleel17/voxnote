# DATABASE LAYER

## OVERVIEW
SQLite（sqlx）CRUD 模組。每個資源一個檔案，`models.rs` 集中定義所有 struct，`mod.rs` 管理 migration。

## FILES

| 檔案 | 負責資源 |
|------|---------|
| `mod.rs` | `init_db()` + MIGRATION_SQL + ALTER TABLE migration |
| `models.rs` | 所有 DB struct + Request/Response struct |
| `meeting.rs` | meetings + categories CRUD |
| `participant.rs` | meeting participants CRUD |
| `saved_participant.rs` | 常用參與者（usage_count） |
| `recording.rs` | recordings CRUD |
| `transcript.rs` | transcripts CRUD（original/proofread 版本切換） |
| `summary.rs` | summaries CRUD |
| `tag.rs` | tags + meeting_tags CRUD |
| `meeting_template.rs` | meeting templates CRUD |
| `category.rs` | categories 獨立操作 |

## SCHEMA NOTES

- `recordings` 表有兩個 ALTER TABLE 後加欄位：`sort_order INTEGER DEFAULT 0`、`segment_transcript TEXT`
- `transcripts.active_version`：`'original'` 或 `'proofread'`
- `meeting_tags`：複合 PK（meeting_id, tag_id），無獨立 id 欄位

## CONVENTIONS

- migration 順序：先執行 MIGRATION_SQL（CREATE TABLE IF NOT EXISTS），後執行 ALTER TABLE（錯誤忽略）
- 聚合查詢（如 MeetingWithDetails）在 `meeting.rs` 中以多次查詢組裝，非 JOIN
- 所有函式接受 `&SqlitePool` 參數（不持有 connection）

## ANTI-PATTERNS

- 禁止刪除或修改現有欄位型別（只能 ADD COLUMN）
- 禁止在此層呼叫 LLM 或 ASR
- 新 struct 必須在 `models.rs` 定義，不得分散各檔
