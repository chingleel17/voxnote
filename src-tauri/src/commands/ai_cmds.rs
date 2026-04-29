use sqlx::SqlitePool;
use tauri::{AppHandle, State};

use crate::{
    ai::call_llm,
    config::load_config,
    db::{summary, transcript},
};

const PROOFREAD_SYSTEM: &str = "你是一位專業的逐字稿校對助理。請修正以下逐字稿的錯別字、語句不通順之處，並保持原本的意思和說話風格。直接輸出校正後的完整文字，不要加任何說明。";

const SUMMARY_SYSTEM: &str = "你是一位專業的會議記錄助理。請根據以下會議逐字稿，生成一份結構清晰的會議摘要，包含：主要討論議題、重要決議、待辦事項。使用繁體中文，以 Markdown 格式輸出。";

#[tauri::command]
pub async fn proofread_transcript(
    meeting_id: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<String, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;

    let t = transcript::get_transcript(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("找不到逐字稿")?;

    let original = t.original_content.unwrap_or_default();
    if original.is_empty() {
        return Err("逐字稿內容為空".into());
    }

    let proofread = call_llm(&config, PROOFREAD_SYSTEM, &original)
        .await
        .map_err(|e| e.to_string())?;

    let provider = config.llm_provider.clone();
    transcript::update_proofread(&pool, &meeting_id, &proofread, &provider)
        .await
        .map_err(|e| e.to_string())?;

    Ok(proofread)
}

#[tauri::command]
pub async fn generate_summary(
    meeting_id: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<String, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;

    let t = transcript::get_transcript(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("找不到逐字稿")?;

    // 優先使用校稿版本，若無則用原始版本
    let content = t
        .proofread_content
        .filter(|s| !s.is_empty())
        .or(t.original_content)
        .unwrap_or_default();

    if content.is_empty() {
        return Err("逐字稿內容為空".into());
    }

    let summary_text = call_llm(&config, SUMMARY_SYSTEM, &content)
        .await
        .map_err(|e| e.to_string())?;

    let provider = config.llm_provider.clone();
    summary::upsert_summary(&pool, &meeting_id, &summary_text, &provider)
        .await
        .map_err(|e| e.to_string())?;

    Ok(summary_text)
}
