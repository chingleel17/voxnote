use serde::Serialize;
use sqlx::SqlitePool;
use tauri::{AppHandle, State};

use crate::{
    ai::call_llm,
    config::load_config,
    db::{recording, summary, transcript},
};

const PROOFREAD_SYSTEM: &str = "\
你是一位專業的中文會議記錄校對員。\
請校正以下逐字稿中的錯字（同音字、漏字、多字、標點錯誤）。\
保留所有時間標記 [MM:SS] 不得刪除或修改。\
保留所有講者標記（例如「講者A：」）不得刪除。\
【重要】必須輸出完整的全部逐字稿內容，嚴禁使用任何省略標記，\
例如「[略]」「[...]」「[... 略]」「[省略]」「...」「（以下略）」「（略）」等，\
無論逐字稿有多長，都必須逐行完整輸出，不得跳過任何段落。\
只輸出修正後的完整逐字稿，不要加任何說明或前後文。";

const SUMMARY_SYSTEM: &str = "\
你是一位專業的會議記錄助理。請根據以下逐字稿生成結構清晰的會議摘要。\
使用繁體中文，以 Markdown 格式輸出，包含以下章節（若無相關內容可省略該章節）：\n\
## 會議摘要\n\
## 參與人員\n\
## 主要議題\n\
## 決議事項\n\
## 待辦事項（TODO）\n\
## 重要時間點（含 [MM:SS] 時間標記）\n\
## 專有名詞說明";

/// 逐字稿分段時，對每個片段提取重點的輕量 prompt
const CHUNK_SUMMARY_SYSTEM: &str = "\
你是一位專業的會議記錄助理。請根據以下會議逐字稿片段，提取關鍵資訊。\
使用繁體中文條列式輸出，包含：決議事項、待辦事項（TODO）、主要討論重點、重要時間點（含 [MM:SS] 時間標記）。\
請精簡扼要，不需輸出完整摘要格式，只需條列重點。";

/// 各段重點合併後，生成最終完整摘要的 prompt
const FINAL_SUMMARY_SYSTEM: &str = "\
你是一位專業的會議記錄助理。以下是一場會議各段落的重點摘要，請根據這些資料整合生成完整的會議摘要。\
使用繁體中文，以 Markdown 格式輸出，包含以下章節（若無相關內容可省略該章節）：\n\
## 會議摘要\n\
## 參與人員\n\
## 主要議題\n\
## 決議事項\n\
## 待辦事項（TODO）\n\
## 重要時間點（含 [MM:SS] 時間標記）\n\
## 專有名詞說明";

/// 將逐字稿依行分塊，每塊不超過 max_chars 字元（完整行不截斷）
fn chunk_transcript(text: &str, max_chars: usize) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        let line_with_nl = format!("{}\n", line);
        if !current.is_empty() && current.len() + line_with_nl.len() > max_chars {
            chunks.push(current.trim_end().to_string());
            current = String::new();
        }
        current.push_str(&line_with_nl);
    }
    let trimmed = current.trim_end().to_string();
    if !trimmed.is_empty() {
        chunks.push(trimmed);
    }
    chunks
}

/// 偵測 LLM 是否使用省略標記（如 [略]、[... 略]、[...]）輸出不完整內容
fn detect_abbreviation(text: &str) -> bool {
    // 「略]」出現超過 3 次（允許正常用詞如「大略」「概略」）
    let abbrev_bracket = text.matches("略]").count();
    if abbrev_bracket > 3 {
        return true;
    }
    // 「[...]」或「[…]」省略號模式
    if text.matches("[...]").count() > 3 || text.matches("[…]").count() > 3 {
        return true;
    }
    false
}
fn count_timestamps(text: &str) -> usize {
    let mut count = 0;
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut i = 0;
    while i + 6 < len {
        if bytes[i] == b'['
            && bytes[i + 3] == b':'
            && bytes[i + 1].is_ascii_digit()
            && bytes[i + 2].is_ascii_digit()
            && bytes[i + 4].is_ascii_digit()
            && bytes[i + 5].is_ascii_digit()
        {
            count += 1;
            i += 6;
        } else {
            i += 1;
        }
    }
    count
}

fn is_chunk_likely_incomplete(original: &str, proofread: &str) -> bool {
    if proofread.trim().is_empty() {
        return true;
    }

    if detect_abbreviation(proofread) {
        return true;
    }

    let orig_chars = original.chars().count();
    let proof_chars = proofread.chars().count();
    if orig_chars > 0 && (proof_chars as f64 / orig_chars as f64) < 0.45 {
        return true;
    }

    let orig_ts = count_timestamps(original);
    let proof_ts = count_timestamps(proofread);
    orig_ts > 0 && (proof_ts as f64 / orig_ts as f64) < 0.5
}

struct ProofreadAttempt {
    result: ProofreadResult,
    should_retry: bool,
}

fn is_retriable_proofread_error(message: &str) -> bool {
    message.contains("回傳空內容")
        || message.contains("輸出不完整")
        || message.contains("遭截斷")
        || message.contains("未產生正文")
}

#[derive(Serialize)]
pub struct ProofreadResult {
    pub content: String,
    pub warning: Option<String>,
}

async fn proofread_text_for_chunks(
    config: &crate::config::AppConfig,
    original: &str,
    proofread_system: &str,
    chunks: Vec<String>,
) -> Result<ProofreadAttempt, String> {
    let total_chunks = chunks.len();

    let mut proofread_chunks: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut should_retry = false;
    for (i, chunk) in chunks.iter().enumerate() {
        let chunk_result = call_llm(config, proofread_system, chunk)
            .await
            .map_err(|e| {
                if total_chunks > 1 {
                    format!("AI 校稿失敗（第{}/{}段）：{}", i + 1, total_chunks, e)
                } else {
                    e.to_string()
                }
            })?;

        if chunk_result.trim().is_empty() {
            should_retry = true;
            warnings.push(format!(
                "第{}/{}段模型回傳空內容，可能是輸出遭截斷或模型未產生正文。",
                i + 1,
                total_chunks
            ));
        }

        if detect_abbreviation(&chunk_result) {
            let msg = if total_chunks > 1 {
                format!(
                    "第{}/{}段模型輸出了省略標記（[略]/[...]），結果可能不完整。",
                    i + 1,
                    total_chunks
                )
            } else {
                "模型輸出了省略標記（[略]/[...]），結果可能不完整。".to_string()
            };
            warnings.push(msg);
            should_retry = true;
        }

        let chunk_orig_chars = chunk.chars().count();
        let chunk_proof_chars = chunk_result.chars().count();
        if chunk_orig_chars > 0 {
            let chunk_ratio = chunk_proof_chars as f64 / chunk_orig_chars as f64;
            if chunk_ratio < 0.45 {
                warnings.push(format!(
                    "第{}/{}段結果字數（{}字）明顯少於原始（{}字），可能有截斷。",
                    i + 1,
                    total_chunks,
                    chunk_proof_chars,
                    chunk_orig_chars
                ));
                should_retry = true;
            }
        }

        let chunk_orig_ts = count_timestamps(chunk);
        let chunk_proof_ts = count_timestamps(&chunk_result);
        if chunk_orig_ts > 0 {
            let chunk_ts_ratio = chunk_proof_ts as f64 / chunk_orig_ts as f64;
            if chunk_ts_ratio < 0.50 {
                warnings.push(format!(
                    "第{}/{}段時間標記數量（{}個）少於原始（{}個），可能有段落遺失或格式遭改動。",
                    i + 1,
                    total_chunks,
                    chunk_proof_ts,
                    chunk_orig_ts
                ));
                should_retry = true;
            }
        }

        if is_chunk_likely_incomplete(chunk, &chunk_result) {
            should_retry = true;
        }

        proofread_chunks.push(chunk_result);
    }

    let proofread = proofread_chunks.join("\n");
    let orig_chars = original.chars().count();
    let proof_chars = proofread.chars().count();
    let orig_ts = count_timestamps(original);
    let proof_ts = count_timestamps(&proofread);

    let char_ratio = if orig_chars > 0 {
        proof_chars as f64 / orig_chars as f64
    } else {
        1.0
    };
    let ts_ratio = if orig_ts > 0 {
        proof_ts as f64 / orig_ts as f64
    } else {
        1.0
    };

    if char_ratio < 0.60 {
        warnings.push(format!(
            "校稿結果字數（{}字）明顯少於原始逐字稿（{}字），可能有內容遺失。",
            proof_chars, orig_chars
        ));
    }
    if orig_ts > 0 && ts_ratio < 0.70 {
        warnings.push(format!(
            "校稿後時間標記數量（{}個）少於原始（{}個），可能有段落遺失或格式遭改動。",
            proof_ts, orig_ts
        ));
        should_retry = true;
    }

    let warning = (!warnings.is_empty()).then(|| warnings.join(" "));

    Ok(ProofreadAttempt {
        result: ProofreadResult {
            content: proofread,
            warning,
        },
        should_retry,
    })
}

async fn proofread_text(
    config: &crate::config::AppConfig,
    original: &str,
) -> Result<ProofreadResult, String> {
    if original.is_empty() {
        return Err("逐字稿內容為空".into());
    }

    let proofread_system: &str = if config.proofread_prompt.is_empty() {
        PROOFREAD_SYSTEM
    } else {
        &config.proofread_prompt
    };
    const CHUNK_SIZES: [usize; 4] = [4000, 2500, 1500, 900];
    let mut last_retry_warning: Option<String> = None;

    for (attempt_index, chunk_size) in CHUNK_SIZES.iter().enumerate() {
        let chunks = chunk_transcript(original, *chunk_size);
        let attempt = match proofread_text_for_chunks(config, original, proofread_system, chunks)
            .await
        {
            Ok(attempt) => attempt,
            Err(err)
                if is_retriable_proofread_error(&err) && attempt_index + 1 < CHUNK_SIZES.len() =>
            {
                last_retry_warning = Some(err);
                continue;
            }
            Err(err) => return Err(err),
        };
        if !attempt.should_retry {
            return Ok(attempt.result);
        }

        last_retry_warning = attempt.result.warning.clone();
        if attempt_index + 1 == CHUNK_SIZES.len() {
            break;
        }
    }

    Err(format!(
        "AI 校稿結果多次重試後仍可能不完整，已停止儲存。{}",
        last_retry_warning.unwrap_or_else(|| {
            "請改用較小模型片段、關閉模型思考模式，或確認供應商輸出限制。".to_string()
        })
    ))
}

#[tauri::command]
pub async fn proofread_transcript(
    meeting_id: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<ProofreadResult, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;

    let t = transcript::get_transcript(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("找不到逐字稿")?;

    let original = t.original_content.unwrap_or_default();
    transcript::mark_proofread_running(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?;

    let proofread = match proofread_text(&config, &original).await {
        Ok(result) => result,
        Err(err) => {
            transcript::mark_proofread_failed(&pool, &meeting_id, &err)
                .await
                .map_err(|e| e.to_string())?;
            return Err(err);
        }
    };

    let provider = config.llm_provider.clone();
    if let Err(e) = transcript::update_proofread(
        &pool,
        &meeting_id,
        &proofread.content,
        &provider,
        proofread.warning.as_deref(),
    )
    .await
    {
        let error = e.to_string();
        transcript::mark_proofread_failed(&pool, &meeting_id, &error)
            .await
            .map_err(|mark_err| mark_err.to_string())?;
        return Err(error);
    }
    recording::clear_segment_proofreads_for_meeting(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(proofread)
}

#[tauri::command]
pub async fn proofread_recording_segment(
    meeting_id: String,
    recording_id: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<ProofreadResult, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;
    let recording_item = recording::get_recording_by_id(&pool, &recording_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("找不到錄音段落")?;

    if recording_item.meeting_id != meeting_id {
        return Err("錄音段落不屬於此會議".into());
    }

    let original_segment = recording_item
        .segment_transcript
        .ok_or("此錄音段落尚未產生逐字稿")?;

    let proofread_segment = proofread_text(&config, &original_segment).await?;
    recording::update_segment_proofread(&pool, &recording_id, &proofread_segment.content)
        .await
        .map_err(|e| e.to_string())?;

    if transcript::get_transcript(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?
        .is_none()
    {
        let merged_original = recording::get_segment_transcripts_with_break(&pool, &meeting_id)
            .await
            .map_err(|e| e.to_string())
            .map(|segments| recording::merge_segment_texts(&segments))?;

        if !merged_original.is_empty() {
            transcript::upsert_transcript_original(&pool, &meeting_id, &merged_original)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    let merged_proofread = recording::get_merged_proofread_text(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("無法建立校稿後逐字稿")?;

    let provider = config.llm_provider.clone();
    transcript::update_proofread(
        &pool,
        &meeting_id,
        &merged_proofread,
        &provider,
        proofread_segment.warning.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(proofread_segment)
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
        .manual_content
        .filter(|s| !s.is_empty())
        .or(t.proofread_content.filter(|s| !s.is_empty()))
        .or(t.original_content)
        .unwrap_or_default();

    if content.is_empty() {
        return Err("逐字稿內容為空".into());
    }

    // 使用自訂 prompt（若設定為空則用內建預設）
    let summary_system: &str = if config.summary_prompt.is_empty() {
        SUMMARY_SYSTEM
    } else {
        &config.summary_prompt
    };

    // 分塊總結：超過 20,000 字元時分段處理，避免模型靜默截斷
    const SUMMARY_CHUNK_SIZE: usize = 20_000;
    let summary_text = if content.len() <= SUMMARY_CHUNK_SIZE {
        call_llm(&config, summary_system, &content)
            .await
            .map_err(|e| e.to_string())?
    } else {
        // 分塊：每塊用輕量 prompt 提取重點
        let chunks = chunk_transcript(&content, SUMMARY_CHUNK_SIZE);
        let total_chunks = chunks.len();
        let mut chunk_summaries: Vec<String> = Vec::new();
        for (i, chunk) in chunks.iter().enumerate() {
            let partial = call_llm(&config, CHUNK_SUMMARY_SYSTEM, chunk)
                .await
                .map_err(|e| format!("會議總結失敗（第{}/{}段）：{}", i + 1, total_chunks, e))?;
            chunk_summaries.push(partial);
        }
        // 各段重點合併後，再做一次整合摘要
        let combined = chunk_summaries
            .iter()
            .enumerate()
            .map(|(i, s)| format!("【第{}段重點】\n{}", i + 1, s))
            .collect::<Vec<_>>()
            .join("\n\n");
        let final_system: &str = if config.summary_prompt.is_empty() {
            FINAL_SUMMARY_SYSTEM
        } else {
            &config.summary_prompt
        };
        call_llm(&config, final_system, &combined)
            .await
            .map_err(|e| e.to_string())?
    };

    let provider = config.llm_provider.clone();
    summary::upsert_summary(&pool, &meeting_id, &summary_text, &provider)
        .await
        .map_err(|e| e.to_string())?;

    Ok(summary_text)
}
