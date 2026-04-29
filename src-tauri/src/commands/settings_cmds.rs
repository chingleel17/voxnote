use tauri::AppHandle;

use crate::config::{load_config, save_config, AppConfig};

// reqwest 在 Cargo.toml 中已引入，此處直接使用

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<AppConfig, String> {
    load_config(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_settings(app: AppHandle, config: AppConfig) -> Result<(), String> {
    save_config(&app, &config).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_ollama_connection(endpoint: String) -> Result<bool, String> {
    let url = format!("{}/api/version", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::new();
    match client.get(&url).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn get_ollama_models(endpoint: String) -> Result<Vec<String>, String> {
    let url = format!("{}/api/tags", endpoint.trim_end_matches('/'));
    let client = reqwest::Client::new();

    let resp = client
        .get(&url)
        .send()
        .await
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
