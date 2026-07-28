use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::State;

use crate::db;

/// 前端組好的待寫入文字檔（逐字稿、摘要、會議資訊）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTextFile {
    pub file_name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingExportResult {
    /// 匯出子資料夾的絕對路徑；已存在而未覆寫時為 None
    pub output_path: Option<String>,
    /// 成功寫入的檔案數（含音訊與文字檔）
    pub written: u64,
    /// 被跳過的項目說明
    pub skipped: Vec<String>,
    /// 目標子資料夾已存在且未指定覆寫
    pub already_exists: bool,
}

/// 匯出單場會議的整包內容至指定父資料夾下的子資料夾
#[tauri::command]
pub async fn export_meeting_bundle(
    meeting_id: String,
    parent_dir: String,
    folder_name: String,
    text_files: Vec<ExportTextFile>,
    overwrite: bool,
    pool: State<'_, SqlitePool>,
) -> Result<MeetingExportResult, String> {
    let parent = PathBuf::from(&parent_dir);
    if !parent.is_dir() {
        return Err(format!("找不到目標資料夾：{}", parent_dir));
    }

    let target_dir = parent.join(&folder_name);
    if target_dir.exists() && !overwrite {
        return Ok(MeetingExportResult {
            output_path: None,
            written: 0,
            skipped: Vec::new(),
            already_exists: true,
        });
    }

    let recordings = db::recording::get_recordings(&pool, &meeting_id)
        .await
        .map_err(|error| format!("無法讀取錄音資料：{}", error))?;

    // 子資料夾為本次匯出新建時，若後續步驟失敗需移除以免留下半成品
    let created_by_this_export = !target_dir.exists();
    std::fs::create_dir_all(&target_dir)
        .map_err(|error| format!("無法建立匯出資料夾：{}", error))?;

    let cleanup_on_error = |error: String| -> String {
        if created_by_this_export {
            let _ = std::fs::remove_dir_all(&target_dir);
        }
        error
    };

    let mut written: u64 = 0;
    let mut skipped: Vec<String> = Vec::new();

    // 音訊：來源檔遺失或複製失敗僅記錄並繼續，不中斷整體匯出
    for (index, recording) in recordings.iter().enumerate() {
        let Some(source_path) = recording.file_path.as_deref() else {
            skipped.push(format!("第 {} 段錄音沒有檔案路徑", index + 1));
            continue;
        };

        let source = Path::new(source_path);
        if !source.is_file() {
            skipped.push(format!("第 {} 段錄音的檔案不存在：{}", index + 1, source_path));
            continue;
        }

        let target_name = format!(
            "{:02}_{}",
            index + 1,
            build_audio_file_name(recording.original_file_name.as_deref(), source)
        );
        match std::fs::copy(source, target_dir.join(&target_name)) {
            Ok(_) => written += 1,
            Err(error) => {
                skipped.push(format!("第 {} 段錄音複製失敗：{}", index + 1, error));
            }
        }
    }

    // 文字檔：寫入失敗代表目錄不可寫，視為硬錯誤
    for file in &text_files {
        let file_name = sanitize_file_name(&file.file_name);
        if file_name.is_empty() {
            continue;
        }

        std::fs::write(target_dir.join(&file_name), &file.content).map_err(|error| {
            cleanup_on_error(format!("無法寫入 {}：{}", file_name, error))
        })?;
        written += 1;
    }

    Ok(MeetingExportResult {
        output_path: Some(target_dir.to_string_lossy().to_string()),
        written,
        skipped,
        already_exists: false,
    })
}

const DEFAULT_AUDIO_STEM: &str = "recording";

/// 檔名主體取自 original_file_name（使用者匯入時的原始命名），副檔名一律沿用磁碟上的來源檔。
/// 兩者必須分開取：commit_temporary_recording 固定以 .wav 落檔，而 original_file_name
/// 可能為 null 或帶著匯入前的副檔名，直接沿用會產生無法播放的檔名。
fn build_audio_file_name(original_file_name: Option<&str>, source: &Path) -> String {
    let stem = original_file_name
        // 先清洗再取 stem：original_file_name 是使用者匯入時的檔名，
        // 其中的 '/' 會被 Path::file_stem() 當成路徑分隔符而丟棄前半段
        .map(|name| sanitize_file_name(name))
        .map(|name| {
            Path::new(&name)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        })
        .filter(|stem| !stem.is_empty())
        .or_else(|| {
            source
                .file_stem()
                .map(|stem| sanitize_file_name(&stem.to_string_lossy()))
                .filter(|stem| !stem.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_AUDIO_STEM.to_string());

    match source.extension().map(|ext| sanitize_file_name(&ext.to_string_lossy())) {
        Some(extension) if !extension.is_empty() => format!("{}.{}", stem, extension),
        _ => stem,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 匯入檔案沿用原始命名主體與磁碟副檔名() {
        let name = build_audio_file_name(
            Some("會議錄音 10.m4a"),
            Path::new(r"C:\data\recordings\abc_1778490519228.m4a"),
        );
        assert_eq!(name, "會議錄音 10.m4a");
    }

    #[test]
    fn 副檔名分歧時以磁碟來源檔為準() {
        // original_file_name 帶著匯入前的副檔名，但實際落檔為 .wav
        let name = build_audio_file_name(
            Some("錄音.m4a"),
            Path::new(r"C:\data\recordings\abc_123.wav"),
        );
        assert_eq!(name, "錄音.wav");
    }

    #[test]
    fn 桌面錄音無原始檔名時退回磁碟檔名() {
        // commit_temporary_recording 路徑：original_file_name 為 None
        let name = build_audio_file_name(None, Path::new(r"C:\data\recordings\abc_1778490519228.wav"));
        assert_eq!(name, "abc_1778490519228.wav");
    }

    #[test]
    fn 原始檔名無副檔名時仍補上磁碟副檔名() {
        let name = build_audio_file_name(Some("我的錄音"), Path::new(r"C:\data\rec.m4a"));
        assert_eq!(name, "我的錄音.m4a");
    }

    #[test]
    fn 原始檔名含非法字元時被清洗() {
        let name = build_audio_file_name(Some("Q3/Q4 檢討?.mp3"), Path::new(r"C:\data\rec.mp3"));
        assert_eq!(name, "Q3_Q4 檢討_.mp3");
    }

    #[test]
    fn 原始檔名為空白時退回磁碟檔名() {
        let name = build_audio_file_name(Some("   "), Path::new(r"C:\data\rec_9.m4a"));
        assert_eq!(name, "rec_9.m4a");
    }

    #[test]
    fn 兩者皆無可用檔名時使用預設值() {
        // 來源路徑取不出任何檔名主體時才會用到預設值
        let name = build_audio_file_name(None, Path::new(".."));
        assert_eq!(name, DEFAULT_AUDIO_STEM);
    }

    #[test]
    fn 檔名清洗移除路徑分隔符避免寫出至目標目錄之外() {
        // 分隔符替換為底線後，開頭的點被 trim_matches 移除，無法向上層跳脫
        let cleaned = sanitize_file_name(r"..\..\etc\passwd");
        assert_eq!(cleaned, "_.._etc_passwd");
        assert!(!cleaned.contains('\\') && !cleaned.contains('/'));
        assert!(!Path::new(&cleaned).components().any(|c| matches!(c, std::path::Component::ParentDir)));

        assert_eq!(sanitize_file_name("a/b"), "a_b");
        // 全形冒號不屬於 Windows 非法字元，應原樣保留
        assert_eq!(sanitize_file_name("進度：完成"), "進度：完成");
    }
}

/// 移除檔名中的路徑分隔符與作業系統非法字元，避免寫出至預期目錄之外
fn sanitize_file_name(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if (ch as u32) < 0x20 => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}
