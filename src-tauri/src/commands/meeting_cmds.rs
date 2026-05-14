use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use tauri::{AppHandle, State};

use crate::db::{
    category, meeting,
    models::{Category, CreateMeetingRequest, MeetingWithDetails, UpdateMeetingRequest},
    recording, summary, transcript,
};
use crate::config::load_config;

#[tauri::command]
pub async fn get_meetings(pool: State<'_, SqlitePool>) -> Result<Vec<MeetingWithDetails>, String> {
    meeting::get_meetings(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_archived_meetings(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<MeetingWithDetails>, String> {
    meeting::get_archived_meetings(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_meeting(
    id: String,
    pool: State<'_, SqlitePool>,
) -> Result<Option<MeetingWithDetails>, String> {
    meeting::get_meeting(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_meeting(
    request: CreateMeetingRequest,
    pool: State<'_, SqlitePool>,
) -> Result<MeetingWithDetails, String> {
    meeting::create_meeting(&pool, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_meeting(
    id: String,
    request: UpdateMeetingRequest,
    pool: State<'_, SqlitePool>,
) -> Result<MeetingWithDetails, String> {
    meeting::update_meeting(&pool, &id, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_meeting(id: String, pool: State<'_, SqlitePool>) -> Result<(), String> {
    meeting::delete_meeting(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn archive_meeting(
    id: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<MeetingWithDetails, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;
    let archive_root = config.archive_storage_dir.trim();
    if archive_root.is_empty() {
        return Err("請先在設定中指定封存資料夾".into());
    }

    let meeting_detail = meeting::get_meeting(&pool, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "找不到會議".to_string())?;
    if meeting_detail.archived_at.is_some() {
        return Err("此會議已封存".into());
    }

    let archive_dir =
        build_archive_directory(Path::new(archive_root), &meeting_detail).map_err(|e| e.to_string())?;
    let recordings_dir = archive_dir.join("recordings");
    std::fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;

    let recordings = recording::get_recordings(&pool, &id)
        .await
        .map_err(|e| e.to_string())?;
    let mut planned_moves: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    for (index, rec) in recordings.iter().enumerate() {
        let Some(path_str) = rec.file_path.as_deref() else {
            continue;
        };
        let source_path = PathBuf::from(path_str);
        if !source_path.exists() {
            return Err(format!("找不到錄音檔：{}", source_path.to_string_lossy()));
        }

        let file_name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(String::from)
            .unwrap_or_else(|| format!("recording-{:02}.bin", index + 1));
        let target_path = recordings_dir.join(format!("{}_{}", rec.id, file_name));
        planned_moves.push((rec.id.clone(), source_path, target_path));
    }

    let mut moved_files: Vec<(String, PathBuf, PathBuf)> = Vec::new();
    for (recording_id, source_path, target_path) in planned_moves {
        move_file(&source_path, &target_path).map_err(|e| e.to_string())?;
        moved_files.push((recording_id, source_path, target_path));
    }

    let persist_result: Result<(), String> = async {
        if let Some(transcript_value) = transcript::get_transcript(&pool, &id)
            .await
            .map_err(|e| e.to_string())?
        {
            if let Some(original) = transcript_value.original_content {
                std::fs::write(archive_dir.join("transcript_original.txt"), original).map_err(|e| e.to_string())?;
            }
            if let Some(proofread) = transcript_value.proofread_content {
                std::fs::write(archive_dir.join("transcript_proofread.txt"), proofread).map_err(|e| e.to_string())?;
            }
            if let Some(manual) = transcript_value.manual_content {
                std::fs::write(archive_dir.join("transcript_manual.txt"), manual).map_err(|e| e.to_string())?;
            }
        }

        if let Some(summary_value) = summary::get_summary(&pool, &id)
            .await
            .map_err(|e| e.to_string())?
        {
            std::fs::write(archive_dir.join("summary.md"), summary_value.content).map_err(|e| e.to_string())?;
        }

        let metadata = serde_json::json!({
            "id": meeting_detail.id,
            "title": meeting_detail.title,
            "category_id": meeting_detail.category_id,
            "category_name": meeting_detail.category_name,
            "participants": meeting_detail.participants,
            "tags": meeting_detail.tags,
            "meeting_date": meeting_detail.meeting_date,
            "created_at": meeting_detail.created_at,
            "updated_at": meeting_detail.updated_at,
        });
        std::fs::write(
            archive_dir.join("meeting.json"),
            serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        for (recording_id, _, target_path) in &moved_files {
            let target_path_str = target_path.to_string_lossy().to_string();
            recording::update_recording_file_path(&pool, recording_id, &target_path_str)
                .await
                .map_err(|e| e.to_string())?;
        }
        let archive_dir_str = archive_dir.to_string_lossy().to_string();
        meeting::archive_meeting(&pool, &id, Some(&archive_dir_str))
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;

    if let Err(err) = persist_result {
        rollback_archived_files(&pool, &moved_files).await;
        return Err(err);
    }

    meeting::get_meeting(&pool, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "封存後無法取得會議".to_string())
}

#[tauri::command]
pub async fn unarchive_meeting(
    id: String,
    pool: State<'_, SqlitePool>,
) -> Result<MeetingWithDetails, String> {
    meeting::unarchive_meeting(&pool, &id)
        .await
        .map_err(|e| e.to_string())?;
    meeting::get_meeting(&pool, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "取消封存後無法取得會議".to_string())
}

#[tauri::command]
pub async fn get_categories(pool: State<'_, SqlitePool>) -> Result<Vec<Category>, String> {
    category::get_categories(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_category(
    name: String,
    pool: State<'_, SqlitePool>,
) -> Result<Category, String> {
    category::create_category(&pool, &name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_category(id: String, pool: State<'_, SqlitePool>) -> Result<(), String> {
    category::delete_category(&pool, &id)
        .await
        .map_err(|e| e.to_string())
}

fn build_archive_directory(root: &Path, meeting: &MeetingWithDetails) -> Result<PathBuf, std::io::Error> {
    std::fs::create_dir_all(root)?;
    let title = sanitize_path_segment(&meeting.title);
    let date = meeting
        .meeting_date
        .as_deref()
        .map(sanitize_path_segment)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "undated".to_string());
    let suffix = meeting.id.chars().take(8).collect::<String>();
    Ok(root.join(format!("{date}_{title}_{suffix}")))
}

fn sanitize_path_segment(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ if ch.is_control() => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .to_string();
    if sanitized.is_empty() {
        "meeting".to_string()
    } else {
        sanitized
    }
}

fn move_file(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(source, target)?;
            std::fs::remove_file(source)?;
            Ok(())
        }
    }
}

async fn rollback_archived_files(
    pool: &SqlitePool,
    moved_files: &[(String, PathBuf, PathBuf)],
) {
    for (recording_id, source_path, target_path) in moved_files.iter().rev() {
        if target_path.exists() {
            let _ = move_file(target_path, source_path);
        }
        let source_path_str = source_path.to_string_lossy().to_string();
        let _ = recording::update_recording_file_path(pool, recording_id, &source_path_str).await;
    }
}
