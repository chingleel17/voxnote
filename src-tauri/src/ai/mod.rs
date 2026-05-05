use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::config::AppConfig;

/// 雲端 API（OpenAI / Claude / Gemini）超時設定
const CLOUD_TIMEOUT_SECS: u64 = 120;
/// 本地 Ollama / 自訂端點超時設定（模型首次載入可能需要較長時間）
const LOCAL_TIMEOUT_SECS: u64 = 600;

// 統一 LLM 呼叫入口
pub async fn call_llm(config: &AppConfig, system_prompt: &str, user_content: &str) -> Result<String> {
    match config.llm_provider.as_str() {
        "openai" => {
            if config.openai_key.is_empty() {
                return Err(anyhow!("OpenAI API Key 未設定"));
            }
            openai_compat_call(
                "https://api.openai.com/v1/chat/completions",
                &config.openai_key,
                &config.openai_model,
                system_prompt,
                user_content,
                CLOUD_TIMEOUT_SECS,
            )
            .await
        }
        "openrouter" => {
            if config.openrouter_key.is_empty() {
                return Err(anyhow!("OpenRouter API Key 未設定"));
            }
            openai_compat_call(
                "https://openrouter.ai/api/v1/chat/completions",
                &config.openrouter_key,
                &config.openrouter_model,
                system_prompt,
                user_content,
                CLOUD_TIMEOUT_SECS,
            )
            .await
        }
        "ollama" => {
            if config.ollama_endpoint.is_empty() {
                return Err(anyhow!("Ollama Endpoint 未設定"));
            }
            if config.ollama_model.is_empty() {
                return Err(anyhow!("Ollama 模型未選擇"));
            }
            let url = format!(
                "{}/v1/chat/completions",
                config.ollama_endpoint.trim_end_matches('/')
            );
            openai_compat_call(&url, "", &config.ollama_model, system_prompt, user_content, LOCAL_TIMEOUT_SECS).await
        }
        "custom" => {
            if config.custom_endpoint.is_empty() {
                return Err(anyhow!("自訂端點 URL 未設定"));
            }
            if config.custom_model.is_empty() {
                return Err(anyhow!("自訂端點模型名稱未設定"));
            }
            openai_compat_call(
                &config.custom_endpoint,
                &config.custom_api_key,
                &config.custom_model,
                system_prompt,
                user_content,
                LOCAL_TIMEOUT_SECS,
            )
            .await
        }
        "gemini" => {
            gemini_call(&config.gemini_key, &config.gemini_model, system_prompt, user_content).await
        }
        "claude" => {
            claude_call(&config.claude_key, &config.claude_model, system_prompt, user_content).await
        }
        other => Err(anyhow!("未知的 LLM 供應商：{}", other)),
    }
}

// OpenAI-compatible API（OpenAI / OpenRouter / Ollama / Custom）
async fn openai_compat_call(
    url: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_content: &str,
    timeout_secs: u64,
) -> Result<String> {
    if url.is_empty() {
        return Err(anyhow!("端點 URL 未設定"));
    }
    if model.is_empty() {
        return Err(anyhow!("模型名稱未設定"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()?;
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content }
        ],
        "temperature": 0.3
    });

    let mut req = client.post(url).json(&body);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }

    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            anyhow!("請求逾時（{}秒），請確認 LLM 服務是否正常運作", timeout_secs)
        } else if e.is_connect() {
            anyhow!("無法連接到 LLM 服務（{}），請確認服務已啟動並確認端點設定", url)
        } else {
            anyhow!("HTTP 請求失敗：{}", e)
        }
    })?;
    let status = resp.status();
    let text = resp.text().await?;

    if !status.is_success() {
        return Err(anyhow!("API 回傳錯誤 {}: {}", status, text));
    }

    let json: Value = serde_json::from_str(&text)?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| anyhow!("回應格式異常：{}", text))?;

    Ok(content.to_string())
}

// Gemini 原生 API
async fn gemini_call(api_key: &str, model: &str, system_prompt: &str, user_content: &str) -> Result<String> {
    if api_key.is_empty() {
        return Err(anyhow!("Gemini API Key 未設定"));
    }
    let model = if model.is_empty() { "gemini-2.5-flash" } else { model };
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        model, api_key
    );

    let body = json!({
        "system_instruction": {
            "parts": [{ "text": system_prompt }]
        },
        "contents": [{
            "parts": [{ "text": user_content }]
        }],
        "generationConfig": { "temperature": 0.3 }
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CLOUD_TIMEOUT_SECS))
        .build()?;
    let resp = client.post(&url).json(&body).send().await.map_err(|e| {
        if e.is_timeout() {
            anyhow!("Gemini 請求逾時（{}秒）", CLOUD_TIMEOUT_SECS)
        } else if e.is_connect() {
            anyhow!("無法連接到 Gemini API，請確認網路連線")
        } else {
            anyhow!("Gemini HTTP 請求失敗：{}", e)
        }
    })?;
    let status = resp.status();
    let text = resp.text().await?;

    if !status.is_success() {
        return Err(anyhow!("Gemini API 回傳錯誤 {}: {}", status, text));
    }

    let json: Value = serde_json::from_str(&text)?;
    let content = json["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .ok_or_else(|| anyhow!("Gemini 回應格式異常：{}", text))?;

    Ok(content.to_string())
}

// Anthropic Claude 原生 API
async fn claude_call(api_key: &str, model: &str, system_prompt: &str, user_content: &str) -> Result<String> {
    if api_key.is_empty() {
        return Err(anyhow!("Claude API Key 未設定"));
    }
    let model = if model.is_empty() { "claude-haiku-4-5-20251001" } else { model };

    let body = json!({
        "model": model,
        "max_tokens": 4096,
        "system": system_prompt,
        "messages": [
            { "role": "user", "content": user_content }
        ]
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CLOUD_TIMEOUT_SECS))
        .build()?;
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                anyhow!("Claude 請求逾時（{}秒）", CLOUD_TIMEOUT_SECS)
            } else if e.is_connect() {
                anyhow!("無法連接到 Claude API，請確認網路連線")
            } else {
                anyhow!("Claude HTTP 請求失敗：{}", e)
            }
        })?;

    let status = resp.status();
    let text = resp.text().await?;

    if !status.is_success() {
        return Err(anyhow!("Claude API 回傳錯誤 {}: {}", status, text));
    }

    let json: Value = serde_json::from_str(&text)?;
    let content = json["content"][0]["text"]
        .as_str()
        .ok_or_else(|| anyhow!("Claude 回應格式異常：{}", text))?;

    Ok(content.to_string())
}

// 測試 LLM 連線（發送簡短 ping 請求）
pub async fn test_llm_connection(config: &AppConfig) -> Result<String> {
    call_llm(config, "You are a helpful assistant.", "Reply with OK only.").await
}
