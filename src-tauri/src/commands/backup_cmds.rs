use sqlx::SqlitePool;
use tauri::{AppHandle, Manager, State};

use crate::backup::{self, BackupResult, DataOperationLock, ImportMode, PreflightResult};

#[tauri::command]
pub async fn export_full_backup(
    destination: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<BackupResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    backup::export_backup(&pool, &app_data_dir, destination.into())
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preflight_full_backup(
    source: String,
    app: AppHandle,
) -> Result<PreflightResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    backup::preflight_backup(source.into(), &app_data_dir)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_full_backup(
    source: String,
    mode: ImportMode,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<BackupResult, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let _guard = data_lock.0.write().await;
    backup::import_backup(&pool, &app_data_dir, source.into(), mode)
        .await
        .map_err(|error| error.to_string())
}
