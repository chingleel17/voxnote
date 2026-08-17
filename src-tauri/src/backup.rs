use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use fs4::available_space;
use serde::{Deserialize, Serialize};
use sqlx::{sqlite::{SqliteConnectOptions, SqliteConnection}, Acquire, Row, SqlitePool};
use tokio::sync::{RwLock, RwLockReadGuard};
use uuid::Uuid;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const FORMAT_VERSION: u32 = 1;
const SCHEMA_REVISION: u32 = 1;
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const MAX_UNCOMPRESSED_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const IMPORT_SPACE_MULTIPLIER: u64 = 2;
const DATABASE_ENTRY: &str = "database.sqlite";
const MANIFEST_ENTRY: &str = "manifest.json";

pub struct DataOperationLock(pub RwLock<()>);

impl Default for DataOperationLock {
    fn default() -> Self {
        Self(RwLock::new(()))
    }
}

impl DataOperationLock {
    pub fn try_begin_write(&self) -> Result<RwLockReadGuard<'_, ()>, String> {
        self.0
            .try_read()
            .map_err(|_| "資料還原進行中，暫時無法修改資料".to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format_version: u32,
    pub created_at: String,
    pub app_version: String,
    pub schema_revision: u32,
    pub assets: Vec<AssetEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    pub kind: AssetKind,
    pub owner_id: String,
    pub zip_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssetKind {
    Recording,
    Archive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub output_path: Option<String>,
    pub added: u64,
    pub skipped: u64,
    pub reused: u64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub created_at: String,
    pub meetings: u64,
    pub recordings: u64,
    pub assets: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub summary: BackupSummary,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    Merge,
    Overwrite,
}

pub async fn export_backup(
    pool: &SqlitePool,
    app_data_dir: &Path,
    destination: PathBuf,
) -> Result<BackupResult> {
    let snapshot = app_data_dir.join(format!("backup-snapshot-{}.sqlite", Uuid::new_v4()));
    create_snapshot(pool, &snapshot).await?;
    let result = export_snapshot(&snapshot, &destination).await;
    let _ = fs::remove_file(&snapshot);
    result
}

async fn create_snapshot(pool: &SqlitePool, snapshot: &Path) -> Result<()> {
    let _ = fs::remove_file(snapshot);
    sqlx::query("VACUUM INTO ?")
        .bind(snapshot.to_string_lossy().as_ref())
        .execute(pool)
        .await
        .context("無法建立 SQLite 備份快照")?;
    Ok(())
}

async fn export_snapshot(snapshot: &Path, destination: &Path) -> Result<BackupResult> {
    let source = open_sqlite(snapshot).await?;
    let recording_rows = sqlx::query(
        "SELECT id, file_path, original_file_name FROM recordings WHERE file_path IS NOT NULL",
    )
    .fetch_all(&source)
    .await?;
    let archive_rows =
        sqlx::query("SELECT id, archived_path FROM meetings WHERE archived_path IS NOT NULL")
            .fetch_all(&source)
            .await?;
    source.close().await;

    let snapshot = snapshot.to_owned();
    let destination = destination.to_owned();
    tokio::task::spawn_blocking(move || {
        write_archive(&snapshot, &destination, recording_rows, archive_rows)
    })
    .await
    .context("備份工作意外中止")?
}

fn write_archive(
    snapshot: &Path,
    destination: &Path,
    recording_rows: Vec<sqlx::sqlite::SqliteRow>,
    archive_rows: Vec<sqlx::sqlite::SqliteRow>,
) -> Result<BackupResult> {
    let parent = destination
        .parent()
        .ok_or_else(|| anyhow!("備份路徑缺少上層目錄"))?;
    if !parent.exists() {
        bail!("備份目錄不存在");
    }
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        Uuid::new_v4()
    ));
    let result = (|| -> Result<BackupResult> {
        let file = File::create(&temporary)?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let mut manifest = Manifest {
            format_version: FORMAT_VERSION,
            created_at: Utc::now().to_rfc3339(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            schema_revision: SCHEMA_REVISION,
            assets: Vec::new(),
        };
        let mut warnings = Vec::new();

        zip.start_file(DATABASE_ENTRY, options)?;
        copy_file_to_writer(snapshot, &mut zip)?;

        for row in recording_rows {
            let id: String = row.try_get("id")?;
            let path: String = row.try_get("file_path")?;
            let original: Option<String> = row.try_get("original_file_name")?;
            let source = PathBuf::from(&path);
            if !source.is_file() {
                warnings.push(format!("錄音資產不存在或無法讀取：{id}"));
                continue;
            }
            let name = safe_file_name(
                original
                    .as_deref()
                    .or_else(|| source.file_name().and_then(|name| name.to_str()))
                    .unwrap_or("recording.bin"),
            );
            let zip_path = format!("assets/recordings/{id}/{name}");
            zip.start_file(&zip_path, options)?;
            if let Err(error) = copy_file_to_writer(&source, &mut zip) {
                warnings.push(format!("無法讀取錄音資產 {id}：{error}"));
                continue;
            }
            manifest.assets.push(AssetEntry {
                kind: AssetKind::Recording,
                owner_id: id,
                zip_path,
            });
        }

        for row in archive_rows {
            let id: String = row.try_get("id")?;
            let root = PathBuf::from(row.try_get::<String, _>("archived_path")?);
            if !root.is_dir() {
                warnings.push(format!("封存資產不存在或無法讀取：{id}"));
                continue;
            }
            for file in collect_files(&root)? {
                let relative = file.strip_prefix(&root).context("封存資產路徑無效")?;
                let zip_path = format!(
                    "assets/archives/{id}/{}",
                    relative.to_string_lossy().replace('\\', "/")
                );
                zip.start_file(&zip_path, options)?;
                if let Err(error) = copy_file_to_writer(&file, &mut zip) {
                    warnings.push(format!("無法讀取封存資產 {id}：{error}"));
                    continue;
                }
                manifest.assets.push(AssetEntry {
                    kind: AssetKind::Archive,
                    owner_id: id.clone(),
                    zip_path,
                });
            }
        }

        zip.start_file(MANIFEST_ENTRY, options)?;
        zip.write_all(&serde_json::to_vec(&manifest)?)?;
        zip.finish()?;
        replace_file(&temporary, destination)?;
        Ok(BackupResult {
            output_path: Some(destination.to_string_lossy().to_string()),
            added: manifest.assets.len() as u64,
            skipped: 0,
            reused: 0,
            warnings,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub async fn preflight_backup(source: PathBuf, app_data_dir: &Path) -> Result<PreflightResult> {
    let staging = app_data_dir.join(format!("backup-preflight-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging)?;
    let result = inspect_archive(&source, &staging, app_data_dir).await;
    let _ = fs::remove_dir_all(&staging);
    result
}

async fn inspect_archive(source: &Path, staging: &Path, app_data_dir: &Path) -> Result<PreflightResult> {
    let source = source.to_owned();
    let staging = staging.to_owned();
    let app_data_dir = app_data_dir.to_owned();
    let extraction_dir = staging.clone();
    let manifest = tokio::task::spawn_blocking(move || {
        validate_and_extract_database(&source, &extraction_dir, &app_data_dir)
    })
    .await
    .context("備份預檢意外中止")??;
    validate_manifest(&manifest)?;
    let database = staging.join(DATABASE_ENTRY);
    let backup = open_sqlite(&database).await?;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&backup)
        .await?;
    if integrity != "ok" {
        bail!("備份資料庫完整性檢查失敗：{integrity}");
    }
    let foreign_key_errors = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&backup)
        .await?;
    if !foreign_key_errors.is_empty() {
        bail!("備份資料庫外鍵檢查失敗");
    }
    validate_assets(&backup, &manifest).await?;
    let meetings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings")
        .fetch_one(&backup)
        .await?;
    let recordings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recordings")
        .fetch_one(&backup)
        .await?;
    backup.close().await;
    Ok(PreflightResult {
        summary: BackupSummary {
            created_at: manifest.created_at,
            meetings: meetings as u64,
            recordings: recordings as u64,
            assets: manifest.assets.len() as u64,
        },
        warnings: Vec::new(),
    })
}

pub async fn import_backup(
    pool: &SqlitePool,
    app_data_dir: &Path,
    source: PathBuf,
    mode: ImportMode,
) -> Result<BackupResult> {
    let staging = app_data_dir.join(format!("backup-import-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging)?;
    let result = import_staged(pool, app_data_dir, &source, &staging, mode).await;
    let _ = fs::remove_dir_all(&staging);
    result
}

async fn import_staged(
    pool: &SqlitePool,
    app_data_dir: &Path,
    source: &Path,
    staging: &Path,
    mode: ImportMode,
) -> Result<BackupResult> {
    let source_owned = source.to_owned();
    let staging_owned = staging.to_owned();
    let app_data_dir_owned = app_data_dir.to_owned();
    let manifest =
        tokio::task::spawn_blocking(move || {
            extract_archive(&source_owned, &staging_owned, &app_data_dir_owned)
        })
            .await
            .context("備份解壓意外中止")??;
    validate_manifest(&manifest)?;
    let imported_db = staging.join(DATABASE_ENTRY);
    let imported = open_sqlite(&imported_db).await?;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&imported)
        .await?;
    if integrity != "ok" {
        bail!("備份資料庫完整性檢查失敗：{integrity}");
    }
    validate_assets(&imported, &manifest).await?;
    imported.close().await;

    let staged_assets = staging.join("assets");
    let prepared =
        prepare_asset_paths(&imported_db, &manifest, &staged_assets, app_data_dir).await?;
    match mode {
        ImportMode::Overwrite => {
            overwrite_import(pool, &imported_db, app_data_dir, &prepared, &manifest).await
        }
        ImportMode::Merge => {
            merge_import(pool, &imported_db, app_data_dir, &prepared, &manifest).await
        }
    }
}

async fn prepare_asset_paths(
    database: &Path,
    manifest: &Manifest,
    assets: &Path,
    app_data_dir: &Path,
) -> Result<Vec<AssetEntry>> {
    let imported = open_sqlite(database).await?;
    sqlx::query("UPDATE recordings SET file_path = NULL")
        .execute(&imported)
        .await?;
    sqlx::query("UPDATE meetings SET archived_path = NULL")
        .execute(&imported)
        .await?;
    let mut prepared = Vec::new();
    for asset in &manifest.assets {
        let extracted = assets.join(
            asset
                .zip_path
                .strip_prefix("assets/")
                .unwrap_or(&asset.zip_path),
        );
        if !extracted.is_file() {
            continue;
        }
        match asset.kind {
            AssetKind::Recording => {
                let name = safe_file_name(
                    extracted
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("recording.bin"),
                );
                let destination = app_data_dir
                    .join("recordings")
                    .join(format!("{}_{}", asset.owner_id, name));
                sqlx::query("UPDATE recordings SET file_path = ? WHERE id = ?")
                    .bind(destination.to_string_lossy().as_ref())
                    .bind(&asset.owner_id)
                    .execute(&imported)
                    .await?;
            }
            AssetKind::Archive => {
                let destination = app_data_dir.join("archives").join(&asset.owner_id);
                sqlx::query("UPDATE meetings SET archived_path = ? WHERE id = ?")
                    .bind(destination.to_string_lossy().as_ref())
                    .bind(&asset.owner_id)
                    .execute(&imported)
                    .await?;
            }
        }
        prepared.push(asset.clone());
    }
    imported.close().await;
    Ok(prepared)
}

async fn overwrite_import(
    pool: &SqlitePool,
    database: &Path,
    app_data_dir: &Path,
    assets: &[AssetEntry],
    manifest: &Manifest,
) -> Result<BackupResult> {
    let exchange =
        exchange_managed_assets(app_data_dir, &staged_assets_root(database), assets, true)?;
    let result = replace_database(pool, database).await;
    match result {
        Ok(()) => {
            exchange.commit()?;
            Ok(BackupResult {
                output_path: None,
                added: manifest.assets.len() as u64,
                skipped: 0,
                reused: 0,
                warnings: missing_asset_warnings(manifest, assets),
            })
        }
        Err(error) => {
            exchange.rollback()?;
            Err(error)
        }
    }
}

async fn merge_import(
    pool: &SqlitePool,
    database: &Path,
    app_data_dir: &Path,
    assets: &[AssetEntry],
    manifest: &Manifest,
) -> Result<BackupResult> {
    let imported = open_sqlite(database).await?;
    let source_meetings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings")
        .fetch_one(&imported)
        .await?;
    imported.close().await;
    let exchange =
        exchange_managed_assets(app_data_dir, &staged_assets_root(database), assets, false)?;
    let result = merge_database(pool, database).await;
    match result {
        Ok((added, reused)) => {
            exchange.commit()?;
            Ok(BackupResult {
                output_path: None,
                added,
                skipped: (source_meetings as u64).saturating_sub(added),
                reused,
                warnings: missing_asset_warnings(manifest, assets),
            })
        }
        Err(error) => {
            exchange.rollback()?;
            Err(error)
        }
    }
}

async fn replace_database(pool: &SqlitePool, database: &Path) -> Result<()> {
    let mut connection = pool.acquire().await?;
    attach_database(&mut connection, database).await?;
    let result = async {
        let mut tx = connection.begin().await?;
        for table in [
            "voiceprints", "recording_speaker_embeddings", "recording_speaker_mappings",
            "speaker_mappings", "meeting_tags", "recordings", "summaries", "transcripts",
            "participants", "meeting_templates", "meetings", "tags", "categories",
            "saved_participants",
        ] {
            sqlx::query(&format!("DELETE FROM {table}")).execute(&mut *tx).await?;
        }
        for table in [
            "categories", "meetings", "participants", "speaker_mappings", "transcripts", "summaries",
            "recordings", "recording_speaker_mappings", "recording_speaker_embeddings",
            "saved_participants", "voiceprints", "meeting_templates", "tags", "meeting_tags",
        ] {
            sqlx::query(&format!("INSERT INTO {table} SELECT * FROM backup.{table}"))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await
    }
    .await;
    let detach_result = detach_database(&mut connection).await;
    result?;
    detach_result?;
    Ok(())
}

async fn merge_database(pool: &SqlitePool, database: &Path) -> Result<(u64, u64)> {
    let mut connection = pool.acquire().await?;
    attach_database(&mut connection, database).await?;
    let result = async {
        let mut tx = connection.begin().await?;
        let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings").fetch_one(&mut *tx).await?;
        let reused_categories: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM backup.categories source JOIN categories target ON target.name = source.name").fetch_one(&mut *tx).await?;
        let reused_tags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM backup.tags source JOIN tags target ON target.name = source.name").fetch_one(&mut *tx).await?;
        let reused_participants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM backup.saved_participants source JOIN saved_participants target ON target.name = source.name").fetch_one(&mut *tx).await?;
        sqlx::query("INSERT OR IGNORE INTO categories SELECT * FROM backup.categories").execute(&mut *tx).await?;
        sqlx::query("INSERT OR IGNORE INTO tags SELECT * FROM backup.tags").execute(&mut *tx).await?;
        sqlx::query("INSERT INTO saved_participants (id, name, usage_count, created_at) SELECT id, name, usage_count, created_at FROM backup.saved_participants WHERE 1 ON CONFLICT(name) DO UPDATE SET usage_count = MAX(saved_participants.usage_count, excluded.usage_count)").execute(&mut *tx).await?;
        sqlx::query("UPDATE backup.meetings SET category_id = (SELECT categories.id FROM categories JOIN backup.categories source ON source.name = categories.name WHERE source.id = backup.meetings.category_id) WHERE category_id IS NOT NULL").execute(&mut *tx).await?;
        sqlx::query("UPDATE backup.meeting_templates SET category_id = (SELECT categories.id FROM categories JOIN backup.categories source ON source.name = categories.name WHERE source.id = backup.meeting_templates.category_id) WHERE category_id IS NOT NULL").execute(&mut *tx).await?;
        sqlx::query("UPDATE backup.meeting_tags SET tag_id = (SELECT tags.id FROM tags JOIN backup.tags source ON source.name = tags.name WHERE source.id = backup.meeting_tags.tag_id)").execute(&mut *tx).await?;
        for table in ["meetings", "participants", "speaker_mappings", "transcripts", "summaries", "recordings", "recording_speaker_mappings", "recording_speaker_embeddings", "meeting_templates", "meeting_tags"] {
            sqlx::query(&format!("INSERT OR IGNORE INTO {table} SELECT * FROM backup.{table}")).execute(&mut *tx).await?;
        }
        // voiceprints 的 participant_id 指向來源庫的 saved_participants.id；合併時
        // saved_participants 依 name 去重（見上方 upsert），來源與目的的 id 可能不同，
        // 故須先將備份中的 participant_id 轉換為目的庫中同名參與者的 id 再寫入
        sqlx::query("UPDATE backup.voiceprints SET participant_id = (SELECT saved_participants.id FROM saved_participants JOIN backup.saved_participants source ON source.name = saved_participants.name WHERE source.id = backup.voiceprints.participant_id) WHERE participant_id IS NOT NULL").execute(&mut *tx).await?;
        sqlx::query("INSERT OR IGNORE INTO voiceprints SELECT * FROM backup.voiceprints").execute(&mut *tx).await?;
        let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM meetings").fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(((after - before) as u64, (reused_categories + reused_tags + reused_participants) as u64))
    }.await;
    let detach_result = detach_database(&mut connection).await;
    let result = result?;
    detach_result?;
    Ok(result)
}

async fn attach_database(connection: &mut SqliteConnection, database: &Path) -> Result<()> {
    sqlx::query("ATTACH DATABASE ? AS backup")
        .bind(database.to_string_lossy().as_ref())
        .execute(connection)
        .await?;
    Ok(())
}

async fn detach_database(connection: &mut SqliteConnection) -> Result<()> {
    sqlx::query("DETACH DATABASE backup").execute(connection).await?;
    Ok(())
}

fn staged_assets_root(database: &Path) -> PathBuf {
    database
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("assets")
}

struct AssetExchange {
    app_data_dir: PathBuf,
    previous: PathBuf,
    stage: PathBuf,
    copied: Vec<PathBuf>,
    overwrite: bool,
}

impl AssetExchange {
    fn commit(self) -> Result<()> {
        if self.previous.exists() {
            fs::remove_dir_all(self.previous)?;
        }
        if self.stage.exists() {
            fs::remove_dir_all(self.stage)?;
        }
        Ok(())
    }
    fn rollback(self) -> Result<()> {
        if !self.overwrite {
            for path in self.copied {
                if path.exists() {
                    fs::remove_file(path)?;
                }
            }
            if self.stage.exists() {
                fs::remove_dir_all(self.stage)?;
            }
            return Ok(());
        }
        for name in ["recordings", "archives"] {
            let target = self.app_data_dir.join(name);
            if target.exists() {
                fs::remove_dir_all(&target)?;
            }
            let old = self.previous.join(name);
            if old.exists() {
                fs::rename(old, target)?;
            }
        }
        if self.previous.exists() {
            fs::remove_dir_all(self.previous)?;
        }
        if self.stage.exists() {
            fs::remove_dir_all(self.stage)?;
        }
        Ok(())
    }
}

fn exchange_managed_assets(
    app_data_dir: &Path,
    extracted_assets: &Path,
    assets: &[AssetEntry],
    overwrite: bool,
) -> Result<AssetExchange> {
    let previous = app_data_dir.join(format!("backup-assets-old-{}", Uuid::new_v4()));
    let stage = app_data_dir.join(format!("backup-assets-new-{}", Uuid::new_v4()));
    fs::create_dir_all(&stage)?;
    for asset in assets {
        let source = extracted_assets.join(
            asset
                .zip_path
                .strip_prefix("assets/")
                .unwrap_or(&asset.zip_path),
        );
        let relative = match asset.kind {
            AssetKind::Recording => {
                let name = safe_file_name(
                    source
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("recording.bin"),
                );
                PathBuf::from("recordings").join(format!("{}_{}", asset.owner_id, name))
            }
            AssetKind::Archive => Path::new(&asset.zip_path)
                .strip_prefix("assets/")
                .context("資產路徑無效")?
                .to_owned(),
        };
        let target = stage.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, target)?;
    }
    if overwrite {
        fs::create_dir_all(&previous)?;
        for name in ["recordings", "archives"] {
            let target = app_data_dir.join(name);
            if target.exists() {
                fs::rename(&target, previous.join(name))?;
            }
            let next = stage.join(name);
            if next.exists() {
                fs::rename(next, target)?;
            } else {
                fs::create_dir_all(target)?;
            }
        }
    } else {
        let copied = copy_new_files(&stage, app_data_dir)?;
        return Ok(AssetExchange {
            app_data_dir: app_data_dir.to_owned(),
            previous,
            stage,
            copied,
            overwrite,
        });
    }
    Ok(AssetExchange {
        app_data_dir: app_data_dir.to_owned(),
        previous,
        stage,
        copied: Vec::new(),
        overwrite,
    })
}

fn missing_asset_warnings(manifest: &Manifest, prepared: &[AssetEntry]) -> Vec<String> {
    let prepared: HashSet<&str> = prepared
        .iter()
        .map(|asset| asset.zip_path.as_str())
        .collect();
    manifest
        .assets
        .iter()
        .filter(|asset| !prepared.contains(asset.zip_path.as_str()))
        .map(|asset| format!("資產未還原：{}", asset.owner_id))
        .collect()
}

fn validate_and_extract_database(source: &Path, staging: &Path, app_data_dir: &Path) -> Result<Manifest> {
    let mut archive = ZipArchive::new(File::open(source)?)?;
    ensure_available_space(app_data_dir, validate_zip_entries(&mut archive)?)?;
    let manifest = read_manifest(&mut archive)?;
    let mut entry = archive
        .by_name(DATABASE_ENTRY)
        .context("備份缺少 database.sqlite")?;
    let mut file = File::create(staging.join(DATABASE_ENTRY))?;
    io::copy(&mut entry, &mut file)?;
    Ok(manifest)
}

fn extract_archive(source: &Path, staging: &Path, app_data_dir: &Path) -> Result<Manifest> {
    let mut archive = ZipArchive::new(File::open(source)?)?;
    ensure_available_space(app_data_dir, validate_zip_entries(&mut archive)?)?;
    let manifest = read_manifest(&mut archive)?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        let path = safe_zip_path(entry.name())?;
        let target = staging.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(target)?;
        io::copy(&mut entry, &mut file)?;
    }
    Ok(manifest)
}

fn validate_zip_entries(archive: &mut ZipArchive<File>) -> Result<u64> {
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        bail!("備份項目數量超過安全上限");
    }
    let mut names = HashSet::new();
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let name = entry.name().to_string();
        safe_zip_path(&name)?;
        if !names.insert(name) {
            bail!("備份包含重複項目");
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            bail!("備份不得包含符號連結");
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| anyhow!("備份大小無效"))?;
        if total > MAX_UNCOMPRESSED_BYTES {
            bail!("備份解壓大小超過安全上限");
        }
    }
    if !names.contains(MANIFEST_ENTRY) || !names.contains(DATABASE_ENTRY) {
        bail!("備份缺少必要項目");
    }
    Ok(total)
}

fn ensure_available_space(app_data_dir: &Path, uncompressed_bytes: u64) -> Result<()> {
    let required = uncompressed_bytes
        .checked_mul(IMPORT_SPACE_MULTIPLIER)
        .ok_or_else(|| anyhow!("備份解壓大小無效"))?;
    let available = available_space(app_data_dir)
        .with_context(|| format!("無法取得 AppData 可用空間：{}", app_data_dir.display()))?;
    if available < required {
        bail!("AppData 可用空間不足，匯入至少需要 {required} 位元組，目前可用 {available} 位元組");
    }
    Ok(())
}

fn read_manifest(archive: &mut ZipArchive<File>) -> Result<Manifest> {
    let mut entry = archive.by_name(MANIFEST_ENTRY)?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes).context("manifest 格式無效")?)
}

fn validate_manifest(manifest: &Manifest) -> Result<()> {
    if manifest.format_version != FORMAT_VERSION {
        bail!("不支援的備份格式版本");
    }
    if manifest.schema_revision != SCHEMA_REVISION {
        bail!("不支援的資料庫 schema revision");
    }
    let mut paths = HashSet::new();
    for asset in &manifest.assets {
        safe_zip_path(&asset.zip_path)?;
        if !paths.insert(&asset.zip_path) {
            bail!("manifest 包含重複資產路徑");
        }
    }
    Ok(())
}

async fn validate_assets(database: &SqlitePool, manifest: &Manifest) -> Result<()> {
    for asset in &manifest.assets {
        let exists: i64 = match asset.kind {
            AssetKind::Recording => {
                sqlx::query_scalar("SELECT COUNT(*) FROM recordings WHERE id = ?")
                    .bind(&asset.owner_id)
                    .fetch_one(database)
                    .await?
            }
            AssetKind::Archive => {
                sqlx::query_scalar("SELECT COUNT(*) FROM meetings WHERE id = ?")
                    .bind(&asset.owner_id)
                    .fetch_one(database)
                    .await?
            }
        };
        if exists != 1 {
            bail!("manifest 資產未對應至資料庫項目：{}", asset.owner_id);
        }
    }
    Ok(())
}

async fn open_sqlite(path: &Path) -> Result<SqlitePool> {
    Ok(SqlitePool::connect_with(
        SqliteConnectOptions::new()
            .filename(path)
            .foreign_keys(true),
    )
    .await?)
}

fn safe_zip_path(name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.contains('\\') {
        bail!("備份包含不安全路徑");
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("備份包含不安全路徑");
    }
    Ok(path.to_owned())
}

fn safe_file_name(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control()
            {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let name = name.trim_matches('.').trim();
    if name.is_empty() {
        "file.bin".into()
    } else {
        name.to_string()
    }
}

fn copy_file_to_writer(path: &Path, writer: &mut ZipWriter<File>) -> Result<()> {
    let mut input = File::open(path)?;
    io::copy(&mut input, writer)?;
    Ok(())
}
fn collect_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            files.extend(collect_files(&path)?);
        } else if path.is_file() {
            files.push(path);
        }
    }
    Ok(files)
}
fn copy_new_files(source: &Path, destination: &Path) -> Result<Vec<PathBuf>> {
    let mut copied = Vec::new();
    for file in collect_files(source)? {
        let relative = file.strip_prefix(source)?;
        let target = destination.join(relative);
        if !target.exists() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(file, &target)?;
            copied.push(target);
        }
    }
    Ok(copied)
}
fn replace_file(temporary: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        fs::remove_file(destination)?;
    }
    fs::rename(temporary, destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    async fn create_test_database(path: &Path) -> SqlitePool {
        File::create(path).expect("建立測試資料庫檔失敗");
        let pool = open_sqlite(path).await.expect("建立測試資料庫失敗");
        sqlx::query(
            "CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT UNIQUE, created_at TEXT);
             CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, category_id TEXT, archived_at TEXT, archived_path TEXT, created_at TEXT, updated_at TEXT);
             CREATE TABLE participants (id TEXT PRIMARY KEY, meeting_id TEXT, name TEXT);
             CREATE TABLE speaker_mappings (id TEXT PRIMARY KEY, meeting_id TEXT, recording_id TEXT, speaker_label TEXT, participant_name TEXT, created_at TEXT, updated_at TEXT);
             CREATE TABLE transcripts (id TEXT PRIMARY KEY);
             CREATE TABLE summaries (id TEXT PRIMARY KEY);
             CREATE TABLE recordings (id TEXT PRIMARY KEY, meeting_id TEXT, file_path TEXT);
             CREATE TABLE recording_speaker_mappings (id TEXT PRIMARY KEY);
             CREATE TABLE saved_participants (id TEXT PRIMARY KEY, name TEXT UNIQUE, usage_count INTEGER, created_at TEXT);
             CREATE TABLE meeting_templates (id TEXT PRIMARY KEY, name TEXT, title TEXT, category_id TEXT, participants_json TEXT, created_at TEXT);
             CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT UNIQUE, color TEXT, created_at TEXT);
             CREATE TABLE meeting_tags (meeting_id TEXT, tag_id TEXT);
             CREATE TABLE voiceprints (id TEXT PRIMARY KEY, participant_id TEXT, model TEXT, vector TEXT, created_at TEXT);
             CREATE TABLE recording_speaker_embeddings (id TEXT PRIMARY KEY, meeting_id TEXT, recording_id TEXT, speaker_label TEXT, model TEXT, vector TEXT, created_at TEXT);",
        )
        .execute(&pool)
        .await
        .expect("建立測試 schema 失敗");
        pool
    }

    fn test_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("voxnote-backup-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("建立測試目錄失敗");
        path
    }

    #[test]
    fn rejects_unsafe_zip_paths() {
        assert!(safe_zip_path("../database.sqlite").is_err());
        assert!(safe_zip_path("C:/database.sqlite").is_err());
        assert!(safe_zip_path("assets\\recording.wav").is_err());
        assert!(safe_zip_path("assets/recording.wav").is_ok());
    }

    #[test]
    fn sanitizes_recording_name() {
        assert_eq!(safe_file_name("a:b?.wav"), "a_b_.wav");
        assert_eq!(safe_file_name("..."), "file.bin");
    }

    #[test]
    fn only_accepts_current_manifest_versions() {
        let manifest = Manifest {
            format_version: FORMAT_VERSION,
            created_at: String::new(),
            app_version: String::new(),
            schema_revision: SCHEMA_REVISION,
            assets: Vec::new(),
        };
        assert!(validate_manifest(&manifest).is_ok());
        assert!(validate_manifest(&Manifest {
            format_version: FORMAT_VERSION + 1,
            ..manifest
        })
        .is_err());
    }

    #[tokio::test]
    async fn replace_database_commits_before_detaching_backup() {
        let directory = test_directory();
        let target_path = directory.join("target.sqlite");
        let source_path = directory.join("source.sqlite");
        let target = create_test_database(&target_path).await;
        let source = create_test_database(&source_path).await;
        sqlx::query("INSERT INTO meetings VALUES ('old', 'old', NULL, NULL, NULL, 'now', 'now')")
            .execute(&target)
            .await
            .unwrap();
        sqlx::query("INSERT INTO meetings VALUES ('new', 'new', NULL, NULL, NULL, 'now', 'now')")
            .execute(&source)
            .await
            .unwrap();
        source.close().await;

        replace_database(&target, &source_path).await.unwrap();

        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM meetings ORDER BY id")
            .fetch_all(&target)
            .await
            .unwrap();
        assert_eq!(ids, vec!["new"]);
        target.close().await;
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn merge_database_reuses_names_and_rewrites_foreign_keys() {
        let directory = test_directory();
        let target_path = directory.join("target.sqlite");
        let source_path = directory.join("source.sqlite");
        let target = create_test_database(&target_path).await;
        let source = create_test_database(&source_path).await;
        for statement in [
            "INSERT INTO categories VALUES ('target-category', 'Work', 'now')",
            "INSERT INTO tags VALUES ('target-tag', 'Important', '#fff', 'now')",
            "INSERT INTO saved_participants VALUES ('target-person', 'Alice', 10, 'now')",
        ] {
            sqlx::query(statement).execute(&target).await.unwrap();
        }
        for statement in [
            "INSERT INTO categories VALUES ('source-category', 'Work', 'now')",
            "INSERT INTO tags VALUES ('source-tag', 'Important', '#000', 'now')",
            "INSERT INTO saved_participants VALUES ('source-person', 'Alice', 4, 'now')",
            "INSERT INTO meetings VALUES ('source-meeting', 'Imported', 'source-category', NULL, NULL, 'now', 'now')",
            "INSERT INTO meeting_tags VALUES ('source-meeting', 'source-tag')",
        ] {
            sqlx::query(statement).execute(&source).await.unwrap();
        }
        source.close().await;

        let (added, reused) = merge_database(&target, &source_path).await.unwrap();

        assert_eq!(added, 1);
        assert_eq!(reused, 3);
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT category_id FROM meetings WHERE id = 'source-meeting'").fetch_one(&target).await.unwrap(), "target-category");
        assert_eq!(sqlx::query_scalar::<_, String>("SELECT tag_id FROM meeting_tags WHERE meeting_id = 'source-meeting'").fetch_one(&target).await.unwrap(), "target-tag");
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT usage_count FROM saved_participants WHERE name = 'Alice'").fetch_one(&target).await.unwrap(), 10);
        target.close().await;
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn import_preparation_rewrites_recording_path_to_current_app_data() {
        let directory = test_directory();
        let database_path = directory.join("source.sqlite");
        let source = create_test_database(&database_path).await;
        sqlx::query("INSERT INTO recordings VALUES ('recording-1', 'meeting-1', 'C:/old-user/audio.wav')")
            .execute(&source)
            .await
            .unwrap();
        source.close().await;
        let assets = directory.join("assets");
        let asset_file = assets.join("recordings").join("recording-1").join("audio.wav");
        fs::create_dir_all(asset_file.parent().unwrap()).unwrap();
        fs::write(&asset_file, b"audio").unwrap();
        let manifest = Manifest {
            format_version: FORMAT_VERSION,
            created_at: String::new(),
            app_version: String::new(),
            schema_revision: SCHEMA_REVISION,
            assets: vec![AssetEntry { kind: AssetKind::Recording, owner_id: "recording-1".into(), zip_path: "assets/recordings/recording-1/audio.wav".into() }],
        };
        let app_data = directory.join("new-app-data");
        fs::create_dir_all(&app_data).unwrap();

        prepare_asset_paths(&database_path, &manifest, &assets, &app_data).await.unwrap();

        let imported = open_sqlite(&database_path).await.unwrap();
        let path: String = sqlx::query_scalar("SELECT file_path FROM recordings WHERE id = 'recording-1'")
            .fetch_one(&imported)
            .await
            .unwrap();
        assert_eq!(PathBuf::from(path), app_data.join("recordings").join("recording-1_audio.wav"));
        imported.close().await;
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn import_lock_waits_for_started_write_and_rejects_new_writes() {
        let lock = Arc::new(DataOperationLock::default());
        let read_guard = lock.try_begin_write().unwrap();
        let import_lock = Arc::clone(&lock);
        let (acquired_tx, acquired_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let import = tokio::spawn(async move {
            let write_guard = import_lock.0.write().await;
            let _ = acquired_tx.send(());
            let _ = release_rx.await;
            drop(write_guard);
        });
        tokio::task::yield_now().await;
        assert!(lock.try_begin_write().is_err());
        drop(read_guard);
        acquired_rx.await.unwrap();
        assert!(lock.try_begin_write().is_err());
        release_tx.send(()).unwrap();
        import.await.unwrap();
        assert!(lock.try_begin_write().is_ok());
    }
}
