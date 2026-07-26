use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const LOCAL_ASR_TIMEOUT_SECS: u64 = 600;

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
) -> Result<String> {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err(anyhow!("本地 ASR 伺服器位址未設定"));
    }

    let file_bytes = std::fs::read(file_path).map_err(|e| anyhow!("無法讀取音訊檔案：{}", e))?;
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.wav")
        .to_string();
    let file_part = reqwest::multipart::Part::bytes(file_bytes).file_name(file_name);
    let mut form = reqwest::multipart::Form::new().part("file", file_part);
    if !language.is_empty() && language != "auto" {
        form = form.text("language", language.to_string());
    }
    form = form.text("diarize", speaker_detection.to_string());
    // 已知確切人數時以 min=max 鎖定，提升 pyannote 分離準確度
    if speaker_detection && speakers_expected > 0 {
        let expected = speakers_expected.to_string();
        form = form
            .text("min_speakers", expected.clone())
            .text("max_speakers", expected);
    }

    let client = reqwest::Client::builder()
        .timeout(tokio::time::Duration::from_secs(LOCAL_ASR_TIMEOUT_SECS))
        .build()
        .map_err(|e| anyhow!("無法建立本地 ASR 連線：{}", e))?;
    let url = format!("{}/v1/audio/transcriptions", base_url);

    progress_cb("上傳音訊中...".into());
    progress_cb("轉錄中...".into());
    let response = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                anyhow!("本地 ASR 伺服器連線逾時")
            } else if e.is_connect() {
                anyhow!("無法連線至本地 ASR 伺服器：{}", e)
            } else {
                anyhow!("本地 ASR 伺服器請求失敗：{}", e)
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow!("本地 ASR 伺服器回傳錯誤（{}）：{}", status, detail));
    }

    let result: LocalServerTranscription = response
        .json()
        .await
        .map_err(|e| anyhow!("無法解析本地 ASR 伺服器回應：{}", e))?;
    progress_cb("轉錄完成".into());

    if speaker_detection && !result.segments.is_empty() {
        let lines: Vec<String> = result
            .segments
            .iter()
            .map(|segment| {
                let start_seconds = segment.start.max(0.0) as u64;
                let mm = start_seconds / 60;
                let ss = start_seconds % 60;
                // 僅在服務端實際提供語者標籤時加上講者標記，避免產生誤導性的「講者?」
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
    Ok(result.text)
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
