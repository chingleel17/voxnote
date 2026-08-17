use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Instant;

// 整體請求逾時。長會議錄音的處理時間可觀：實測 158 分鐘的錄音，僅音訊前處理即需
// 約 90 秒，加上轉錄與語者分離總計可達數十分鐘，故放寬至 60 分鐘。
const LOCAL_ASR_TIMEOUT_SECS: u64 = 3600;
// 讀取閒置逾時。整體逾時僅涵蓋至回應標頭送達，此值另外限制傳輸期間的無資料時間，
// 避免伺服器已回 200 卻送不完內容時，前端永久停在「轉譯中」。
const LOCAL_ASR_READ_IDLE_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Deserialize)]
struct LocalServerSegment {
    start: f64,
    text: String,
    speaker: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LocalServerTranscription {
    text: String,
    #[serde(default)]
    segments: Vec<LocalServerSegment>,
    // 講者嵌入向量：鍵為講者代號（A/B/C），與 segments 的 speaker 一致；僅本地 ASR
    // 啟用語者分離且成功取得向量時附上，其餘情況（AssemblyAI、未啟用語者分離、
    // 服務端取得向量失敗）皆從缺，故為選填欄位，沿用既有 #[serde(default)] 慣例。
    #[serde(default)]
    speaker_embeddings: Option<HashMap<String, Vec<f32>>>,
    #[serde(default)]
    diarization_model: Option<String>,
}

/// `transcribe_voxnote_asr` 的完整回傳，供呼叫端在格式化文字之外取得講者嵌入
/// 向量以供聲紋比對；向量僅本地 ASR 供應商啟用語者分離時可能存在。
#[derive(Debug, Clone)]
pub struct VoxnoteAsrResult {
    pub text: String,
    pub speaker_embeddings: HashMap<String, Vec<f32>>,
    pub diarization_model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LocalServerTask {
    task_id: String,
    status: String,
    #[serde(default)]
    progress: u8,
    result: Option<LocalServerTranscription>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LocalAsrInfo {
    pub engine: String,
    pub version: String,
    pub available: bool,
}

// 偵測系統 PATH 中是否有本地 ASR 工具
pub fn detect_local_asr() -> Vec<LocalAsrInfo> {
    let candidates = ["whisper", "faster-whisper", "openai-whisper"];
    let mut results = Vec::new();

    for name in &candidates {
        if let Some(info) = probe_command(name) {
            results.push(info);
        }
    }

    results
}

fn probe_command(name: &str) -> Option<LocalAsrInfo> {
    let version_output = std::process::Command::new(name)
        .arg("--version")
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&version_output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&version_output.stderr).to_string();
    let combined = format!("{}{}", stdout, stderr);
    let first_line = combined.lines().next().unwrap_or("").trim().to_string();

    Some(LocalAsrInfo {
        engine: name.to_string(),
        version: if first_line.is_empty() {
            "unknown".into()
        } else {
            first_line
        },
        available: true,
    })
}

// AssemblyAI 轉錄（上傳 + 輪詢）
pub async fn transcribe_assemblyai(
    api_key: &str,
    file_path: &str,
    language: &str,
    speech_model: &str,
    speaker_detection: bool,
    // 預期講者人數，取自會議與會人員數；0 代表未知，不帶入 API
    speakers_expected: u32,
    progress_cb: impl Fn(String),
) -> Result<String> {
    if api_key.is_empty() {
        return Err(anyhow!("AssemblyAI API Key 未設定"));
    }

    let client = reqwest::Client::new();

    // 1. 上傳音訊
    progress_cb("上傳音訊中...".into());
    let file_bytes = std::fs::read(file_path)?;
    let upload_resp = client
        .post("https://api.assemblyai.com/v2/upload")
        .header("authorization", api_key)
        .header("content-type", "application/octet-stream")
        .body(file_bytes)
        .send()
        .await?;

    if !upload_resp.status().is_success() {
        let text = upload_resp.text().await?;
        return Err(anyhow!("上傳失敗：{}", text));
    }

    let upload_json: Value = upload_resp.json().await?;
    let upload_url = upload_json["upload_url"]
        .as_str()
        .ok_or_else(|| anyhow!("無法取得上傳 URL"))?
        .to_string();

    // 2. 建立轉錄任務
    progress_cb("建立轉錄任務...".into());
    let mut req_body = json!({
        "audio_url": upload_url,
        "speech_models": build_speech_models(speech_model),
    });
    if !language.is_empty() && language != "auto" {
        req_body["language_code"] = json!(language);
    }
    if speaker_detection {
        req_body["speaker_labels"] = json!(true);
        // 已知確切人數時帶入，可提升語者分離準確度；AssemblyAI 支援 1 至 20 人
        // 註：音檔短於 2 分鐘時此參數會被 AssemblyAI 忽略
        if (1..=20).contains(&speakers_expected) {
            req_body["speakers_expected"] = json!(speakers_expected);
        }
    }

    let task_resp = client
        .post("https://api.assemblyai.com/v2/transcript")
        .header("authorization", api_key)
        .json(&req_body)
        .send()
        .await?;

    if !task_resp.status().is_success() {
        let text = task_resp.text().await?;
        return Err(anyhow!("建立轉錄任務失敗：{}", text));
    }

    let task_json: Value = task_resp.json().await?;
    let transcript_id = task_json["id"]
        .as_str()
        .ok_or_else(|| anyhow!("無法取得轉錄 ID"))?
        .to_string();

    // 3. 輪詢結果
    let poll_url = format!("https://api.assemblyai.com/v2/transcript/{}", transcript_id);
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

        let poll_resp = client
            .get(&poll_url)
            .header("authorization", api_key)
            .send()
            .await?;

        let poll_json: Value = poll_resp.json().await?;
        let status = poll_json["status"].as_str().unwrap_or("error");

        match status {
            "completed" => {
                progress_cb("轉錄完成".into());
                // 若有說話人偵測，使用 utterances 格式
                if speaker_detection {
                    if let Some(utterances) = poll_json["utterances"].as_array() {
                        if !utterances.is_empty() {
                            let lines: Vec<String> = utterances
                                .iter()
                                .map(|u| {
                                    let start_ms = u["start"].as_u64().unwrap_or(0);
                                    let speaker = u["speaker"].as_str().unwrap_or("?");
                                    let text = u["text"].as_str().unwrap_or("");
                                    let mm = start_ms / 60000;
                                    let ss = (start_ms % 60000) / 1000;
                                    format!("[{:02}:{:02} 講者{}] {}", mm, ss, speaker, text)
                                })
                                .collect();
                            return Ok(lines.join("\n"));
                        }
                    }
                }
                let text = poll_json["text"]
                    .as_str()
                    .ok_or_else(|| anyhow!("轉錄結果為空"))?
                    .to_string();
                return Ok(text);
            }
            "error" => {
                let err = poll_json["error"].as_str().unwrap_or("未知錯誤");
                return Err(anyhow!("AssemblyAI 轉錄失敗：{}", err));
            }
            other => {
                progress_cb(format!("轉錄中（{}）...", other));
            }
        }
    }
}

fn build_speech_models(selected_model: &str) -> Vec<&'static str> {
    match selected_model {
        "universal-3-pro" => vec!["universal-3-pro", "universal-2"],
        _ => vec!["universal-2", "universal-3-pro"],
    }
}

// 本地 ASR 伺服器轉錄（OpenAI 相容 multipart 端點）
pub async fn transcribe_voxnote_asr(
    base_url: &str,
    file_path: &str,
    language: &str,
    speaker_detection: bool,
    // 預期講者人數，取自會議與會人員數；0 代表未知，交由 pyannote 自動偵測
    speakers_expected: u32,
    progress_cb: impl Fn(String),
) -> Result<VoxnoteAsrResult> {
    let file_bytes = tokio::fs::read(file_path)
        .await
        .map_err(|e| anyhow!("無法讀取音訊檔案：{}", e))?;
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.wav")
        .to_string();
    transcribe_voxnote_asr_bytes(
        base_url,
        &file_name,
        file_bytes,
        language,
        speaker_detection,
        speakers_expected,
        progress_cb,
    )
    .await
}

/// 即時字幕逾時錯誤，供呼叫端辨識並略過該視窗（不重試、不中止 session）。
#[derive(Debug)]
pub struct LiveCaptionTimeoutError;

impl std::fmt::Display for LiveCaptionTimeoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "即時字幕遠端轉錄逾時")
    }
}

impl std::error::Error for LiveCaptionTimeoutError {}

/// 將記憶體中的 16 kHz mono f32 音訊送至即時字幕專用的遠端 ASR，不建立暫存音訊檔。
///
/// 與批次的 `transcribe_voxnote_asr_bytes` 分離：使用呼叫端傳入、跨視窗共用的
/// `reqwest::Client`（避免每視窗重建連線），逾時為秒級（與批次的 3600 秒無關），
/// 且不重試——逾時或失敗即回傳錯誤，由呼叫端捨棄該視窗、繼續下一段。
pub async fn transcribe_live_caption_remote(
    client: &reqwest::Client,
    base_url: &str,
    samples: &[f32],
    language: &str,
    timeout_seconds: u64,
) -> Result<String> {
    let base_url = normalize_local_asr_url(base_url)?;
    let form = build_local_asr_form(
        "live-caption.wav",
        encode_pcm_wav(samples),
        language,
        false,
        0,
        true,
    );
    let url = format!("{}/v1/audio/transcriptions", base_url);

    let response = client
        .post(&url)
        .timeout(tokio::time::Duration::from_secs(timeout_seconds))
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                anyhow::Error::new(LiveCaptionTimeoutError)
            } else {
                anyhow!("即時字幕遠端轉錄請求失敗：{}", error)
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "即時字幕遠端伺服器回傳錯誤（{}）：{}",
            status,
            detail
        ));
    }

    let result: LocalServerTranscription = response
        .json()
        .await
        .map_err(|e| anyhow!("無法解析即時字幕遠端回應：{}", e))?;
    format_local_asr_result(&result, false)
}

/// 呼叫低延遲增量端點。此端點只回傳純文字，不經批次的對齊與語者分離流程。
pub async fn transcribe_live_caption_remote_incremental(
    client: &reqwest::Client,
    base_url: &str,
    samples: &[f32],
    language: &str,
    timeout_seconds: u64,
) -> Result<String> {
    let base_url = normalize_local_asr_url(base_url)?;
    let form = build_local_asr_form(
        "live-caption.wav",
        encode_pcm_wav(samples),
        language,
        false,
        0,
        false,
    );
    let url = format!("{}/v1/audio/transcriptions/incremental", base_url);
    let response = client
        .post(&url)
        .timeout(tokio::time::Duration::from_secs(timeout_seconds))
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                anyhow::Error::new(LiveCaptionTimeoutError)
            } else {
                anyhow!("即時字幕低延遲端點請求失敗：{}", error)
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "即時字幕低延遲端點不可用（{}）：{}",
            status,
            detail
        ));
    }

    let result: Value = response
        .json()
        .await
        .map_err(|error| anyhow!("無法解析即時字幕低延遲回應：{}", error))?;
    result["text"]
        .as_str()
        .map(|text| text.trim().to_string())
        .ok_or_else(|| anyhow!("即時字幕低延遲回應缺少 text 欄位"))
}

async fn transcribe_voxnote_asr_bytes(
    base_url: &str,
    file_name: &str,
    file_bytes: Vec<u8>,
    language: &str,
    speaker_detection: bool,
    speakers_expected: u32,
    progress_cb: impl Fn(String),
) -> Result<VoxnoteAsrResult> {
    let base_url = normalize_local_asr_url(base_url)?;
    let form = build_local_asr_form(
        file_name,
        file_bytes,
        language,
        speaker_detection,
        speakers_expected,
        false,
    );
    let client = build_local_asr_client()?;
    let url = format!("{}/v1/audio/transcriptions", base_url);

    progress_cb("上傳音訊中...".into());
    let response = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| map_local_asr_request_error(e, "建立轉錄任務"))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow!("本地 ASR 伺服器回傳錯誤（{}）：{}", status, detail));
    }

    let task: LocalServerTask = response
        .json()
        .await
        .map_err(|e| anyhow!("無法解析本地 ASR 任務回應：{}", e))?;
    if task.task_id.is_empty() {
        return Err(anyhow!("本地 ASR 伺服器未回傳任務 ID"));
    }

    let poll_url = format!("{}/v1/tasks/{}", base_url, task.task_id);
    let started_at = Instant::now();
    let mut last_progress = None;
    loop {
        if started_at.elapsed().as_secs() >= LOCAL_ASR_TIMEOUT_SECS {
            return Err(anyhow!(
                "本地 ASR 任務輪詢逾時（超過 {} 秒）：伺服器可能仍在處理或已中斷，請確認伺服器狀態後重試",
                LOCAL_ASR_TIMEOUT_SECS
            ));
        }
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

        let response = client.get(&poll_url).send().await.map_err(|e| {
            if e.is_timeout() {
                anyhow!(
                    "本地 ASR 任務狀態查詢逾時（超過 {} 秒無回應）",
                    LOCAL_ASR_READ_IDLE_TIMEOUT_SECS
                )
            } else if e.is_connect() {
                anyhow!("本地 ASR 伺服器在輪詢期間無法連線：{}", e)
            } else {
                anyhow!("本地 ASR 任務狀態查詢失敗：{}", e)
            }
        })?;
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "本地 ASR 任務狀態查詢失敗（{}）：{}",
                status,
                detail
            ));
        }

        let task: LocalServerTask = response
            .json()
            .await
            .map_err(|e| anyhow!("無法解析本地 ASR 任務狀態：{}", e))?;
        if last_progress != Some(task.progress) {
            progress_cb(format!("轉錄中（{}%）...", task.progress));
            last_progress = Some(task.progress);
        }

        match task.status.as_str() {
            "queued" | "processing" => continue,
            "done" => {
                progress_cb("轉錄完成".into());
                let result = task
                    .result
                    .ok_or_else(|| anyhow!("本地 ASR 任務完成但未回傳結果"))?;
                let text = format_local_asr_result(&result, speaker_detection)?;
                return Ok(VoxnoteAsrResult {
                    text,
                    speaker_embeddings: result.speaker_embeddings.unwrap_or_default(),
                    diarization_model: result.diarization_model,
                });
            }
            "failed" => {
                return Err(anyhow!(
                    "本地 ASR 轉錄失敗：{}",
                    task.error.unwrap_or_else(|| "未知錯誤".into())
                ));
            }
            other => return Err(anyhow!("本地 ASR 回傳未知任務狀態：{}", other)),
        }
    }
}

fn normalize_local_asr_url(base_url: &str) -> Result<String> {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err(anyhow!("本地 ASR 伺服器位址未設定"));
    }
    Ok(base_url.to_string())
}

fn build_local_asr_form(
    file_name: &str,
    file_bytes: Vec<u8>,
    language: &str,
    speaker_detection: bool,
    speakers_expected: u32,
    sync: bool,
) -> reqwest::multipart::Form {
    let file_part = reqwest::multipart::Part::bytes(file_bytes).file_name(file_name.to_string());
    let mut form = reqwest::multipart::Form::new().part("file", file_part);
    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }
    form = form.text("diarize", speaker_detection.to_string());
    // 與會人員數僅作為上限：單次請求處理的是單一錄音段落，該段未必所有人都發言，
    // 若以 min=max 鎖死會迫使 pyannote 把少數幾人硬拆成與會人數，反而破壞分離結果。
    // 與會名單只有 1 人時多半是尚未填寫完整，此時不設上限以免整段被判為單一語者。
    if speaker_detection && speakers_expected > 1 {
        form = form.text("max_speakers", speakers_expected.to_string());
    }
    if sync {
        form = form.text("sync", "true");
    }
    form
}

fn build_local_asr_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(tokio::time::Duration::from_secs(LOCAL_ASR_TIMEOUT_SECS))
        .read_timeout(tokio::time::Duration::from_secs(
            LOCAL_ASR_READ_IDLE_TIMEOUT_SECS,
        ))
        .build()
        .map_err(|e| anyhow!("無法建立本地 ASR 連線：{}", e))
}

fn map_local_asr_request_error(error: reqwest::Error, action: &str) -> anyhow::Error {
    if error.is_timeout() {
        anyhow!(
            "本地 ASR {}逾時（超過 {} 秒）：長錄音的轉錄與語者分離耗時較長，\
             可縮短錄音分段或確認伺服器狀態",
            action,
            LOCAL_ASR_TIMEOUT_SECS
        )
    } else if error.is_connect() {
        anyhow!("無法連線至本地 ASR 伺服器（{}）：{}", action, error)
    } else {
        anyhow!("本地 ASR {}請求失敗：{}", action, error)
    }
}

fn format_local_asr_result(
    result: &LocalServerTranscription,
    speaker_detection: bool,
) -> Result<String> {
    if speaker_detection && !result.segments.is_empty() {
        let lines: Vec<String> = result
            .segments
            .iter()
            .map(|segment| {
                let start_seconds = segment.start.max(0.0) as u64;
                let mm = start_seconds / 60;
                let ss = start_seconds % 60;
                match segment.speaker.as_deref() {
                    Some(speaker) if !speaker.is_empty() => {
                        format!("[{:02}:{:02} 講者{}] {}", mm, ss, speaker, segment.text)
                    }
                    _ => format!("[{:02}:{:02}] {}", mm, ss, segment.text),
                }
            })
            .collect();
        return Ok(lines.join("\n"));
    }

    if result.text.trim().is_empty() {
        return Err(anyhow!("本地 ASR 伺服器未回傳逐字稿"));
    }
    Ok(result.text.clone())
}

fn encode_pcm_wav(samples: &[f32]) -> Vec<u8> {
    let data_size = (samples.len() * 2) as u32;
    let riff_size = 36 + data_size;
    let mut bytes = Vec::with_capacity(riff_size as usize + 8);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&riff_size.to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&16_000u32.to_le_bytes());
    bytes.extend_from_slice(&32_000u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

// 本地 Whisper CLI 轉錄
pub async fn transcribe_local_whisper(
    engine: &str,
    model: &str,
    file_path: &str,
    language: &str,
) -> Result<String> {
    let engine = if engine.is_empty() { "whisper" } else { engine };
    let model = if model.is_empty() { "base" } else { model };

    let mut args = vec![file_path, "--model", model];
    let lang_str: String;
    if !language.is_empty() && language != "auto" {
        lang_str = language.to_string();
        args.extend(["--language", &lang_str]);
    }

    let output = tokio::process::Command::new(engine)
        .args(&args)
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(anyhow!("Whisper 執行失敗：{}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        return Err(anyhow!("Whisper 未產生輸出，請確認音訊檔案有效"));
    }

    // 解析 Whisper 輸出，保留時間戳格式：[MM:SS] text
    Ok(parse_whisper_stdout(&stdout))
}

fn parse_whisper_stdout(stdout: &str) -> String {
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            // Whisper 輸出格式：[00:00.000 --> 00:03.000]  text
            if line.starts_with('[') {
                if let Some(rest) = line.strip_prefix('[') {
                    if let Some(bracket_end) = rest.find(']') {
                        let timestamp = &rest[..bracket_end];
                        let start_part = timestamp.split(" --> ").next().unwrap_or("").trim();
                        let formatted = format_whisper_timestamp(start_part);
                        let text = rest[bracket_end + 1..].trim();
                        if !text.is_empty() {
                            return Some(format!("[{}] {}", formatted, text));
                        }
                    }
                }
                None
            } else if !line.is_empty() {
                Some(line.to_string())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_whisper_timestamp(ts: &str) -> String {
    // "00:00.000" 或 "01:23.456" 或 "01:23:45.678"
    let parts: Vec<&str> = ts.split(':').collect();
    match parts.len() {
        2 => {
            let mm: u64 = parts[0].parse().unwrap_or(0);
            let ss: f64 = parts[1].parse().unwrap_or(0.0);
            format!("{:02}:{:02}", mm, ss as u64)
        }
        3 => {
            let hh: u64 = parts[0].parse().unwrap_or(0);
            let mm: u64 = parts[1].parse().unwrap_or(0);
            format!("{:02}:{:02}", hh * 60 + mm, 0u64)
        }
        _ => ts.to_string(),
    }
}
