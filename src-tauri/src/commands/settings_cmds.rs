use tauri::AppHandle;

use crate::ai::test_llm_connection;
use crate::config::{load_config, save_config, AppConfig};

const OLLAMA_HTTP_TIMEOUT_SECS: u64 = 10;
const LOCAL_ASR_HTTP_TIMEOUT_SECS: u64 = 10;
const MODEL_LIST_HTTP_TIMEOUT_SECS: u64 = 15;
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<AppConfig, String> {
    load_config(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, config: AppConfig) -> Result<(), String> {
    save_config(&app, &config).map_err(|e| e.to_string())
}

// 通用 LLM 連線測試（傳入當前設定，發送一個簡短請求）
#[tauri::command]
pub async fn test_llm_connection_cmd(app: AppHandle) -> Result<String, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;
    test_llm_connection(&config)
        .await
        .map_err(|e| e.to_string())
}

// Ollama 連線測試（保留，用於 Ollama 專屬測試按鈕）
#[tauri::command]
pub async fn test_ollama_connection(endpoint: String) -> Result<bool, String> {
    let url = format!("{}/api/version", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(OLLAMA_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    match client.get(&url).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn test_local_asr_connection(base_url: String) -> Result<bool, String> {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("本地 ASR 伺服器位址未設定".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(LOCAL_ASR_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("無法建立本地 ASR 連線：{}", e))?;
    let response = client
        .get(format!("{}/health", base_url))
        .send()
        .await
        .map_err(|e| format!("無法連線至本地 ASR 伺服器：{}", e))?;

    Ok(response.status().is_success())
}

/// 判斷 OpenAI 相容端點回傳的模型 id 是否為對話模型。
/// 模型清單含 embedding、語音、影像等非對話模型，需濾除以免下拉選單失去可用性。
///
/// 比對範圍僅限 `vendor/model` 中的模型名稱部分，避免供應商名稱誤判
/// （例如 `nousresearch/hermes-4` 的 vendor 含有 "search" 字樣）。
fn is_chat_model_id(id: &str) -> bool {
    const EXCLUDED_KEYWORDS: [&str; 9] = [
        "embedding",
        "whisper",
        "tts",
        "dall-e",
        "moderation",
        "audio",
        "image",
        "realtime",
        "transcribe",
    ];
    let name = id.rsplit('/').next().unwrap_or(id).to_lowercase();
    !EXCLUDED_KEYWORDS.iter().any(|kw| name.contains(kw))
}

#[cfg(test)]
mod tests {
    use super::is_chat_model_id;

    #[test]
    fn keeps_chat_models() {
        for id in [
            "gpt-4.1-mini",
            "claude-opus-4-7",
            "nousresearch/hermes-4-405b",
            "perplexity/sonar-deep-research",
            "meta-llama/llama-guard-4-12b",
            "openai/gpt-4o",
        ] {
            assert!(is_chat_model_id(id), "應保留對話模型：{}", id);
        }
    }

    #[test]
    fn filters_non_chat_models() {
        for id in [
            "text-embedding-3-large",
            "whisper-1",
            "dall-e-3",
            "gpt-4o-realtime-preview",
            "openai/gpt-audio",
            "google/gemini-3-pro-image",
            "omni-moderation-latest",
        ] {
            assert!(!is_chat_model_id(id), "應濾除非對話模型：{}", id);
        }
    }
}

fn build_model_list_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(MODEL_LIST_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("無法建立 HTTP 連線：{}", e))
}

async fn fetch_json(request: reqwest::RequestBuilder, provider: &str) -> Result<serde_json::Value, String> {
    let resp = request
        .send()
        .await
        .map_err(|e| format!("無法連線至 {} API：{}", provider, e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("讀取 {} 回應失敗：{}", provider, e))?;

    if !status.is_success() {
        return Err(format!("{} API 回傳錯誤 {}：{}", provider, status, text));
    }

    serde_json::from_str(&text).map_err(|e| format!("{} 回應格式異常：{}", provider, e))
}

/// 從 OpenAI 相容的 `data[].id` 結構取出模型 id 並排序。
fn extract_openai_style_ids(json: &serde_json::Value) -> Vec<String> {
    let mut models: Vec<String> = json["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str())
                .filter(|id| is_chat_model_id(id))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    models
}

/// 依供應商向其官方端點取得可用模型清單。
/// API Key 一律由後端從設定檔讀取，不經過 IPC 參數傳遞。
#[tauri::command]
pub async fn list_provider_models(app: AppHandle, provider: String) -> Result<Vec<String>, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;
    let client = build_model_list_client()?;

    match provider.as_str() {
        "openai" => {
            if config.openai_key.is_empty() {
                return Err("OpenAI API Key 未設定".into());
            }
            let json = fetch_json(
                client
                    .get("https://api.openai.com/v1/models")
                    .bearer_auth(&config.openai_key),
                "OpenAI",
            )
            .await?;
            Ok(extract_openai_style_ids(&json))
        }
        "claude" => {
            if config.claude_key.is_empty() {
                return Err("Claude API Key 未設定".into());
            }
            // 預設每頁僅 20 筆，明確指定上限以一次取回完整清單
            let json = fetch_json(
                client
                    .get("https://api.anthropic.com/v1/models?limit=1000")
                    .header("x-api-key", &config.claude_key)
                    .header("anthropic-version", ANTHROPIC_VERSION),
                "Claude",
            )
            .await?;
            Ok(extract_openai_style_ids(&json))
        }
        "gemini" => {
            if config.gemini_key.is_empty() {
                return Err("Gemini API Key 未設定".into());
            }
            let json = fetch_json(
                client.get(format!(
                    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key={}",
                    config.gemini_key
                )),
                "Gemini",
            )
            .await?;
            let mut models: Vec<String> = json["models"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        // 僅保留支援 generateContent 的模型，濾除 embedding、TTS 等
                        .filter(|m| {
                            m["supportedGenerationMethods"]
                                .as_array()
                                .map(|methods| {
                                    methods.iter().any(|x| x.as_str() == Some("generateContent"))
                                })
                                .unwrap_or(false)
                        })
                        .filter_map(|m| m["name"].as_str())
                        .map(|name| name.trim_start_matches("models/").to_string())
                        .collect()
                })
                .unwrap_or_default();
            models.sort();
            Ok(models)
        }
        "openrouter" => {
            // OpenRouter 模型清單為公開端點，無 API Key 亦可查詢
            let mut request = client.get("https://openrouter.ai/api/v1/models");
            if !config.openrouter_key.is_empty() {
                request = request.bearer_auth(&config.openrouter_key);
            }
            let json = fetch_json(request, "OpenRouter").await?;
            Ok(extract_openai_style_ids(&json))
        }
        "custom" => {
            if config.custom_endpoint.is_empty() {
                return Err("自訂端點未設定".into());
            }
            let url = format!("{}/models", config.custom_endpoint.trim_end_matches('/'));
            let mut request = client.get(&url);
            if !config.custom_api_key.is_empty() {
                request = request.bearer_auth(&config.custom_api_key);
            }
            let json = fetch_json(request, "自訂端點").await?;
            Ok(extract_openai_style_ids(&json))
        }
        "ollama" => get_ollama_models(config.ollama_endpoint).await,
        other => Err(format!("不支援的 LLM 供應商：{}", other)),
    }
}

// 取得 Ollama 模型列表（保留）
#[tauri::command]
pub async fn get_ollama_models(endpoint: String) -> Result<Vec<String>, String> {
    let url = format!("{}/api/tags", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(OLLAMA_HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let models = json["models"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| m["name"].as_str().map(String::from))
        .collect();

    Ok(models)
}
