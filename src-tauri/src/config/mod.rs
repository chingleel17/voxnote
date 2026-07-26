use anyhow::Result;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)] // 舊版 config.toml 缺少新欄位時，自動填入 Default 值
pub struct AppConfig {
    // ASR 供應商："assemblyai" | "local" | "voxnote_asr"
    pub asr_provider: String,
    pub assembly_ai_key: String,
    pub assembly_ai_speech_model: String, // "universal-2" | "universal-3-pro"
    pub recording_storage_dir: String,
    pub archive_storage_dir: String,
    pub recording_source_mode: String,
    pub recording_microphone_device_id: String,
    pub recording_system_device_id: String,
    pub local_asr_model: String, // "tiny" | "base" | "small" | "medium" | "large"
    pub local_asr_base_url: String,
    pub asr_language: String,                     // "zh" | "en" | "auto"
    pub speaker_detection: bool,                  // 是否啟用說話人偵測
    pub auto_proofread_after_transcription: bool, // 逐段轉譯完成後自動 AI 校稿

    // LLM 供應商："openai" | "claude" | "gemini" | "openrouter" | "ollama" | "custom"
    pub llm_provider: String,
    pub openai_key: String,
    pub openai_model: String,
    pub claude_key: String,
    pub claude_model: String,
    pub gemini_key: String,
    pub gemini_model: String,
    pub openrouter_key: String,
    pub openrouter_model: String,
    pub ollama_endpoint: String,
    pub ollama_model: String,
    pub ollama_think_level: String,
    pub custom_endpoint: String,
    pub custom_api_key: String,
    pub custom_model: String,

    // AI Prompt 自訂（空字串代表使用內建預設 Prompt）
    pub proofread_prompt: String,
    pub summary_prompt: String,

    // Windows 完成通知
    pub completion_notification_enabled: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            asr_provider: "assemblyai".into(),
            assembly_ai_key: String::new(),
            assembly_ai_speech_model: "universal-2".into(),
            recording_storage_dir: String::new(),
            archive_storage_dir: String::new(),
            recording_source_mode: "microphone".into(),
            recording_microphone_device_id: String::new(),
            recording_system_device_id: String::new(),
            local_asr_model: "base".into(),
            local_asr_base_url: String::new(),
            asr_language: "zh".into(),
            speaker_detection: true,
            auto_proofread_after_transcription: false,
            llm_provider: "openai".into(),
            openai_key: String::new(),
            openai_model: "gpt-4.1-mini".into(),
            claude_key: String::new(),
            claude_model: "claude-haiku-4-5-20251001".into(),
            gemini_key: String::new(),
            gemini_model: "gemini-2.5-flash".into(),
            openrouter_key: String::new(),
            openrouter_model: "openai/gpt-4o-mini".into(),
            ollama_endpoint: "http://localhost:11434".into(),
            ollama_model: String::new(),
            ollama_think_level: "low".into(),
            custom_endpoint: String::new(),
            custom_api_key: String::new(),
            custom_model: String::new(),
            proofread_prompt: String::new(),
            summary_prompt: String::new(),
            completion_notification_enabled: true,
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
