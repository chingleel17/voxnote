use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub provider_mode: String,
    pub assembly_ai_key: String,
    pub gemini_key: String,
    pub gemini_model: String,
    pub ollama_endpoint: String,
    pub ollama_llm_model: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            provider_mode: "cloud".into(),
            assembly_ai_key: String::new(),
            gemini_key: String::new(),
            gemini_model: "gemini-2.0-flash".into(),
            ollama_endpoint: "http://localhost:11434".into(),
            ollama_llm_model: String::new(),
        }
    }
}

pub fn load_config(app: &AppHandle) -> Result<AppConfig> {
    use tauri::Manager;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("無法取得 AppData 目錄：{}", e))?;

    let config_path = data_dir.join("config.toml");

    if !config_path.exists() {
        return Ok(AppConfig::default());
    }

    let content = std::fs::read_to_string(&config_path)?;
    let config: AppConfig = toml::from_str(&content)?;
    Ok(config)
}

pub fn save_config(app: &AppHandle, config: &AppConfig) -> Result<()> {
    use tauri::Manager;

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("無法取得 AppData 目錄：{}", e))?;

    std::fs::create_dir_all(&data_dir)?;

    let config_path = data_dir.join("config.toml");
    let content = toml::to_string_pretty(config)?;
    std::fs::write(&config_path, content)?;
    Ok(())
}
