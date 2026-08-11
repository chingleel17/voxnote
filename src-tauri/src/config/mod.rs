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

    // 即時字幕
    pub live_caption_backend: String, // "local_whisper" | "voxnote_asr"
    pub live_caption_model_path: String, // GGML .bin 模型路徑
    pub live_caption_audio_source: String, // "microphone" | "system"
    pub live_caption_window_seconds: u32,
    pub live_caption_step_seconds: u32,
    pub live_caption_silence_threshold: f32,
    pub live_caption_translate: bool,
    pub live_caption_display_mode: String, // "translation" | "original" | "both"
    pub live_caption_font_size: u32,
    pub live_caption_max_lines: u32, // 字幕視窗同時保留的最大行數
    pub live_caption_clear_seconds: u32, // 無新字幕達此秒數即清空，0 代表不清空
    pub live_caption_click_through: bool, // 字幕視窗是否啟用點擊穿透
    // 即時字幕的來源語言與遠端端點與批次流程（asr_language / local_asr_base_url）各自獨立，
    // 因為即時字幕的實際用途（如觀看外語影片）常與批次會議轉錄的語言相反。
    pub live_caption_language: String, // "zh" | "en" | "auto"
    pub live_caption_remote_base_url: String, // 空字串代表沿用 local_asr_base_url
    pub live_caption_remote_model: String,
    pub live_caption_remote_timeout_seconds: u32, // 即時逾時，與批次的 LOCAL_ASR_TIMEOUT_SECS 分離

    // 播放增益：會議錄音響度通常遠低於一般影音內容，故播放時額外補償
    pub playback_gain: f32,        // 增益倍率，1.0 為原始音量
    pub playback_compressor: bool, // 動態壓縮，拉近大小聲差距
    pub playback_highpass: bool,   // 高通濾波，濾除低頻噪音

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
            live_caption_backend: "local_whisper".into(),
            live_caption_model_path: String::new(),
            live_caption_audio_source: "system".into(),
            live_caption_window_seconds: 5,
            live_caption_step_seconds: 3,
            live_caption_silence_threshold: 0.01,
            live_caption_translate: true,
            live_caption_display_mode: "translation".into(),
            live_caption_font_size: 28,
            live_caption_max_lines: 5,
            live_caption_clear_seconds: 8,
            live_caption_click_through: true,
            live_caption_language: "auto".into(),
            live_caption_remote_base_url: String::new(),
            live_caption_remote_model: String::new(),
            live_caption_remote_timeout_seconds: 8,
            // 預設 2 倍增益並開啟壓縮：手機於會議室桌面收音的錄音多半偏小聲
            playback_gain: 2.0,
            playback_compressor: true,
            playback_highpass: true,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_config_gets_playback_defaults() {
        // 既有使用者的 config.toml 沒有播放增益欄位，須靠 serde(default) 補上預設值
        let legacy = r#"
asr_provider = "voxnote_asr"
speaker_detection = true
"#;
        let config: AppConfig = toml::from_str(legacy).expect("舊版設定應可解析");
        assert_eq!(config.playback_gain, 2.0);
        assert!(config.playback_compressor);
        assert!(config.playback_highpass);
        // 既有欄位不應被預設值覆蓋
        assert_eq!(config.asr_provider, "voxnote_asr");
    }

    #[test]
    fn existing_config_gets_new_live_caption_defaults() {
        // 既有使用者的 config.toml 已有即時字幕欄位，但沒有後續新增的三項；
        // 若 serde(default) 未涵蓋，載入會失敗導致應用程式無法啟動。
        let existing = r#"
asr_language = "zh"
live_caption_backend = "local_whisper"
live_caption_model_path = 'C:\models\ggml-small.bin'
live_caption_audio_source = "system"
live_caption_window_seconds = 15
live_caption_step_seconds = 3
live_caption_silence_threshold = 0.01
live_caption_translate = false
live_caption_display_mode = "original"
live_caption_font_size = 28
"#;
        let config: AppConfig = toml::from_str(existing).expect("既有設定應可解析");
        assert_eq!(config.live_caption_max_lines, 5);
        assert_eq!(config.live_caption_clear_seconds, 8);
        assert!(config.live_caption_click_through);
        // 既有欄位不應被預設值覆蓋
        assert_eq!(config.live_caption_window_seconds, 15);
        assert!(!config.live_caption_translate);
        assert_eq!(config.live_caption_display_mode, "original");
    }

    #[test]
    fn existing_config_gets_live_caption_remote_defaults() {
        // 既有使用者的 config.toml 沒有即時字幕獨立語言／遠端端點欄位，
        // 若 serde(default) 未涵蓋，載入會失敗導致應用程式無法啟動。
        let existing = r#"
asr_language = "zh"
live_caption_backend = "voxnote_asr"
live_caption_click_through = true
"#;
        let config: AppConfig = toml::from_str(existing).expect("既有設定應可解析");
        assert_eq!(config.live_caption_language, "auto");
        assert_eq!(config.live_caption_remote_base_url, "");
        assert_eq!(config.live_caption_remote_model, "");
        assert_eq!(config.live_caption_remote_timeout_seconds, 8);
        // 既有欄位不應被預設值覆蓋
        assert_eq!(config.asr_language, "zh");
    }

    #[test]
    fn playback_settings_round_trip() {
        let mut config = AppConfig::default();
        config.playback_gain = 3.5;
        config.playback_compressor = false;

        let serialized = toml::to_string_pretty(&config).expect("應可序列化");
        let reparsed: AppConfig = toml::from_str(&serialized).expect("應可重新解析");

        assert_eq!(reparsed.playback_gain, 3.5);
        assert!(!reparsed.playback_compressor);
        assert!(reparsed.playback_highpass);
    }
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
