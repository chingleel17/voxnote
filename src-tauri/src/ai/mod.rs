use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::config::AppConfig;

/// 雲端 API（OpenAI / Claude / Gemini）超時設定
const CLOUD_TIMEOUT_SECS: u64 = 120;
/// Ollama 本地推論超時設定
const OLLAMA_TIMEOUT_SECS: u64 = 300;
/// 自訂端點超時設定（保留較長時間給非 Ollama 的本地服務）
const CUSTOM_TIMEOUT_SECS: u64 = 600;
/// Ollama 單次輸出上限，避免模型長時間生成後才失敗
const OLLAMA_MAX_PREDICT: u32 = 4096;

fn response_preview(text: &str) -> String {
    const MAX_PREVIEW_CHARS: usize = 280;
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let preview: String = collapsed.chars().take(MAX_PREVIEW_CHARS).collect();
    if collapsed.chars().count() > MAX_PREVIEW_CHARS {
        format!("{}...", preview)
    } else {
        preview
    }
}

fn extract_text_content(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.to_string()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    let block_type = item.get("type").and_then(Value::as_str);
                    if matches!(
                        block_type,
                        Some("thinking" | "reasoning" | "tool_use" | "tool_result")
                    ) {
                        return None;
                    }
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("content").and_then(Value::as_str))
                })
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
        Value::Object(_) => value
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| value.get("content").and_then(Value::as_str))
            .map(|text| text.to_string()),
        _ => None,
    }
}

fn ensure_non_empty_content(
    provider_label: &str,
    content: String,
    finish_reason: Option<&str>,
    raw_response: &str,
) -> Result<String> {
    if let Some(reason) = finish_reason {
        if matches!(reason, "length" | "max_tokens") {
            return Err(anyhow!(
                "{} 輸出不完整（finish_reason: {}），請縮小片段後重試",
                provider_label,
                reason
            ));
        }
    }

    if content.trim().is_empty() {
        let finish = finish_reason.unwrap_or("unknown");
        return Err(anyhow!(
            "{} 回傳空內容（finish_reason: {}）。原始回應：{}",
            provider_label,
            finish,
            response_preview(raw_response)
        ));
    }

    Ok(content)
}

// 統一 LLM 呼叫入口
pub async fn call_llm(
    config: &AppConfig,
    system_prompt: &str,
    user_content: &str,
) -> Result<String> {
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
            ollama_chat_call(
                &config.ollama_endpoint,
                &config.ollama_model,
                &config.ollama_think_level,
                system_prompt,
                user_content,
            )
            .await
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
                CUSTOM_TIMEOUT_SECS,
            )
            .await
        }
        "gemini" => {
            gemini_call(
                &config.gemini_key,
                &config.gemini_model,
                system_prompt,
                user_content,
            )
            .await
        }
        "claude" => {
            claude_call(
                &config.claude_key,
                &config.claude_model,
                system_prompt,
                user_content,
            )
            .await
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
            anyhow!(
                "請求逾時（{}秒），請確認 LLM 服務是否正常運作",
                timeout_secs
            )
        } else if e.is_connect() {
            anyhow!(
                "無法連接到 LLM 服務（{}），請確認服務已啟動並確認端點設定",
                url
            )
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
    let choice = json["choices"]
        .get(0)
        .ok_or_else(|| anyhow!("回應格式異常：{}", text))?;
    if let Some(refusal) = choice["message"]["refusal"].as_str() {
        return Err(anyhow!("模型拒絕回應：{}", refusal));
    }
    let finish_reason = choice["finish_reason"].as_str();
    let content = extract_text_content(&choice["message"]["content"])
        .or_else(|| choice["text"].as_str().map(|value| value.to_string()))
        .ok_or_else(|| anyhow!("回應格式異常：{}", text))?;

    ensure_non_empty_content("LLM", content, finish_reason, &text)
}

// Ollama 原生 Chat API
async fn ollama_chat_call(
    endpoint: &str,
    model: &str,
    think_level: &str,
    system_prompt: &str,
    user_content: &str,
) -> Result<String> {
    let url = format!("{}/api/chat", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(OLLAMA_TIMEOUT_SECS))
        .build()?;
    let body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content }
        ],
        "stream": false,
        "think": ollama_think_value(think_level),
        "options": {
            "temperature": 0.3,
            "num_predict": OLLAMA_MAX_PREDICT,
        }
    });

    let resp = client.post(&url).json(&body).send().await.map_err(|e| {
        if e.is_timeout() {
            anyhow!(
                "Ollama 請求逾時（{}秒），請縮小逐字稿片段、改用較小模型，或確認模型是否正在長時間思考",
                OLLAMA_TIMEOUT_SECS
            )
        } else if e.is_connect() {
            anyhow!("無法連接到 Ollama（{}），請確認服務已啟動並確認端點設定", url)
        } else {
            anyhow!("Ollama HTTP 請求失敗：{}", e)
        }
    })?;
    let status = resp.status();
    let text = resp.text().await?;

    if !status.is_success() {
        return Err(anyhow!("Ollama API 回傳錯誤 {}: {}", status, text));
    }

    let json: Value = serde_json::from_str(&text)?;
    let done_reason = json["done_reason"].as_str();
    let content = extract_text_content(&json["message"]["content"])
        .ok_or_else(|| anyhow!("Ollama 回應格式異常：{}", text))?;

    ensure_non_empty_content("Ollama", content, done_reason, &text).map_err(|err| {
        if json["message"]["thinking"]
            .as_str()
            .is_some_and(|thinking| !thinking.trim().is_empty())
        {
            anyhow!(
                "{}；若持續發生，請先將 Ollama 思考層級調成「關閉思考」",
                err
            )
        } else {
            err
        }
    })
}

fn ollama_think_value(think_level: &str) -> Value {
    match think_level {
        "low" | "medium" | "high" => Value::String(think_level.to_string()),
        _ => Value::Bool(false),
    }
}

// Gemini 原生 API
async fn gemini_call(
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_content: &str,
) -> Result<String> {
    if api_key.is_empty() {
        return Err(anyhow!("Gemini API Key 未設定"));
    }
    let model = if model.is_empty() {
        "gemini-2.5-flash"
    } else {
        model
    };
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
    let candidate = json["candidates"]
        .get(0)
        .ok_or_else(|| anyhow!("Gemini 回應格式異常：{}", text))?;
    let finish_reason = candidate["finishReason"].as_str();
    let content = extract_text_content(&candidate["content"]["parts"])
        .ok_or_else(|| anyhow!("Gemini 回應格式異常：{}", text))?;

    ensure_non_empty_content("Gemini", content, finish_reason, &text)
}

// Anthropic Claude 原生 API
async fn claude_call(
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_content: &str,
) -> Result<String> {
    if api_key.is_empty() {
        return Err(anyhow!("Claude API Key 未設定"));
    }
    let model = if model.is_empty() {
        "claude-haiku-4-5-20251001"
    } else {
        model
    };

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
    let stop_reason = json["stop_reason"].as_str();
    let content = extract_text_content(&json["content"])
        .ok_or_else(|| anyhow!("Claude 回應格式異常：{}", text))?;

    ensure_non_empty_content("Claude", content, stop_reason, &text)
}

// 測試 LLM 連線（發送簡短 ping 請求）
pub async fn test_llm_connection(config: &AppConfig) -> Result<String> {
    call_llm(
        config,
        "You are a helpful assistant.",
        "Reply with OK only.",
    )
    .await
}
