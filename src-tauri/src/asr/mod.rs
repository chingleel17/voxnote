use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
        version: if first_line.is_empty() { "unknown".into() } else { first_line },
        available: true,
    })
}

// AssemblyAI 轉錄（上傳 + 輪詢）
pub async fn transcribe_assemblyai(
    api_key: &str,
    file_path: &str,
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
    let task_resp = client
        .post("https://api.assemblyai.com/v2/transcript")
        .header("authorization", api_key)
        .json(&json!({ "audio_url": upload_url }))
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
                let text = poll_json["text"]
                    .as_str()
                    .ok_or_else(|| anyhow!("轉錄結果為空"))?
                    .to_string();
                progress_cb("轉錄完成".into());
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

// 本地 Whisper CLI 轉錄
pub async fn transcribe_local_whisper(
    engine: &str,
    model: &str,
    file_path: &str,
) -> Result<String> {
    let engine = if engine.is_empty() { "whisper" } else { engine };
    let model = if model.is_empty() { "base" } else { model };

    let output = tokio::process::Command::new(engine)
        .args([file_path, "--model", model, "--output_format", "txt", "--output_dir", "/tmp"])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(anyhow!("Whisper 執行失敗：{}", stderr));
    }

    // Whisper 輸出 txt 檔案，但也會在 stdout 輸出文字
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        return Err(anyhow!("Whisper 未產生輸出，請確認音訊檔案有效"));
    }

    // 過濾掉時間戳行（[00:00.000 --> 00:01.000]）
    let text: Vec<&str> = stdout
        .lines()
        .filter(|l| !l.trim_start().starts_with('['))
        .collect();

    Ok(text.join("\n").trim().to_string())
}
