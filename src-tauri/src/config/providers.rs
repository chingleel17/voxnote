use std::collections::HashSet;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use super::AppConfig;

// 舊設定在首次儲存前可能載入多次；使用穩定的 UUID v4，避免引用 ID 改變。
const LEGACY_ASSEMBLYAI_ID: &str = "b307cfe8-f55e-4075-a44f-0435bb1b77b7";
const LEGACY_REMOTE_ID: &str = "3a0f5043-7178-4c44-9adf-bb9b70e72e91";
const LEGACY_LOCAL_ID: &str = "d7d2d828-77b2-4bf9-b746-623ab4d93c86";

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AsrProviderKind {
    Assemblyai,
    VoxnoteAsr,
    Local,
}

impl AsrProviderKind {
    pub fn batch_backend(self) -> &'static str {
        match self {
            Self::Assemblyai => "assemblyai",
            Self::VoxnoteAsr => "voxnote_asr",
            Self::Local => "local",
        }
    }

    pub fn live_backend(self) -> &'static str {
        match self {
            Self::Assemblyai => "assemblyai_streaming",
            Self::VoxnoteAsr => "voxnote_asr",
            Self::Local => "local_whisper",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AsrProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: AsrProviderKind,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub live_base_url: String,
    #[serde(default)]
    pub local_model_path: String,
}

// 不讓 AppConfig 的 Debug 輸出意外包含供應商金鑰。
impl std::fmt::Debug for AsrProviderConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AsrProviderConfig")
            .field("id", &self.id)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl AppConfig {
    pub fn initialize_provider_configs(&mut self) {
        if !self.asr_provider_configs.is_empty() {
            return;
        }
        self.asr_provider_configs = vec![
            AsrProviderConfig {
                id: LEGACY_ASSEMBLYAI_ID.into(),
                name: "AssemblyAI".into(),
                kind: AsrProviderKind::Assemblyai,
                api_key: self.assembly_ai_key.clone(),
                base_url: String::new(),
                live_base_url: String::new(),
                local_model_path: String::new(),
            },
            AsrProviderConfig {
                id: LEGACY_REMOTE_ID.into(),
                name: "VoxNote 自架 ASR".into(),
                kind: AsrProviderKind::VoxnoteAsr,
                api_key: String::new(),
                base_url: self.local_asr_base_url.clone(),
                live_base_url: self.live_caption_remote_base_url.clone(),
                local_model_path: String::new(),
            },
            AsrProviderConfig {
                id: LEGACY_LOCAL_ID.into(),
                name: "本地 Whisper".into(),
                kind: AsrProviderKind::Local,
                api_key: String::new(),
                base_url: String::new(),
                live_base_url: String::new(),
                local_model_path: self.live_caption_model_path.clone(),
            },
        ];
        self.asr_provider_id = match self.asr_provider.as_str() {
            "voxnote_asr" => LEGACY_REMOTE_ID,
            "local" => LEGACY_LOCAL_ID,
            _ => LEGACY_ASSEMBLYAI_ID,
        }
        .into();
        self.live_caption_provider_id = match self.live_caption_backend.as_str() {
            "assemblyai_streaming" => LEGACY_ASSEMBLYAI_ID,
            "voxnote_asr" => LEGACY_REMOTE_ID,
            _ => LEGACY_LOCAL_ID,
        }
        .into();
    }

    pub fn validate_provider_configs(&self) -> Result<()> {
        let mut ids = HashSet::new();
        for provider in &self.asr_provider_configs {
            if uuid::Uuid::parse_str(&provider.id).is_err() || !ids.insert(&provider.id) {
                return Err(anyhow!("語音辨識供應商的設定 ID 無效或重複"));
            }
            if provider.name.trim().is_empty() {
                return Err(anyhow!("請填寫語音辨識供應商的設定名稱"));
            }
        }
        self.provider_by_id(&self.asr_provider_id)?;
        self.provider_by_id(&self.live_caption_provider_id)?;
        Ok(())
    }

    fn provider_by_id(&self, id: &str) -> Result<&AsrProviderConfig> {
        self.asr_provider_configs
            .iter()
            .find(|provider| provider.id == id)
            .ok_or_else(|| anyhow!("所選語音辨識供應商設定不存在，請至設定頁重新選擇"))
    }

    pub fn resolve_batch_provider(&self) -> Result<Self> {
        let mut config = self.clone();
        config.initialize_provider_configs();
        let provider = config.provider_by_id(&config.asr_provider_id)?.clone();
        config.asr_provider = provider.kind.batch_backend().into();
        config.assembly_ai_key = provider.api_key;
        config.local_asr_base_url = provider.base_url;
        Ok(config)
    }

    pub fn resolve_live_provider(&self) -> Result<Self> {
        let mut config = self.clone();
        config.initialize_provider_configs();
        let provider = config
            .provider_by_id(&config.live_caption_provider_id)?
            .clone();
        config.live_caption_backend = provider.kind.live_backend().into();
        config.assembly_ai_key = provider.api_key;
        config.local_asr_base_url = provider.base_url;
        config.live_caption_remote_base_url = provider.live_base_url;
        config.live_caption_model_path = provider.local_model_path;
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_migrate_once_preserving_connections_and_service_choices() -> Result<()> {
        let mut config: AppConfig = toml::from_str(
            r#"
assembly_ai_key = "fixture-key"
asr_provider = "assemblyai"
assembly_ai_speech_model = "universal-2"
asr_language = "zh"
local_asr_base_url = "http://localhost:8000"
live_caption_backend = "voxnote_asr"
live_caption_remote_base_url = "http://localhost:8001/live"
live_caption_model_path = 'C:\models\model.bin'
live_caption_language = "en"
"#,
        )?;
        config.initialize_provider_configs();
        let ids: Vec<_> = config
            .asr_provider_configs
            .iter()
            .map(|p| p.id.clone())
            .collect();
        config.initialize_provider_configs();
        assert_eq!(
            ids,
            config
                .asr_provider_configs
                .iter()
                .map(|p| p.id.clone())
                .collect::<Vec<_>>()
        );
        let batch = config.resolve_batch_provider()?;
        let live = config.resolve_live_provider()?;
        assert_eq!(batch.assembly_ai_key, "fixture-key");
        assert_eq!(batch.assembly_ai_speech_model, "universal-2");
        assert_eq!(batch.asr_language, "zh");
        assert_eq!(
            live.live_caption_remote_base_url,
            "http://localhost:8001/live"
        );
        assert_eq!(live.live_caption_language, "en");
        assert_eq!(
            config.asr_provider_configs[2].local_model_path,
            r"C:\models\model.bin"
        );
        let reparsed: AppConfig = toml::from_str(&toml::to_string(&config)?)?;
        assert_eq!(reparsed.asr_provider_id, config.asr_provider_id);
        assert_eq!(reparsed.asr_provider_configs[0].api_key, "fixture-key");
        Ok(())
    }

    #[test]
    fn two_profiles_of_the_same_kind_resolve_independently() -> Result<()> {
        let mut config = AppConfig::default();
        config.initialize_provider_configs();
        let mut second = config.asr_provider_configs[0].clone();
        second.id = uuid::Uuid::new_v4().to_string();
        second.name = "串流帳戶".into();
        second.api_key = "live-fixture".into();
        config.live_caption_provider_id = second.id.clone();
        config.asr_provider_configs.push(second);
        config.asr_provider_configs[0].api_key = "batch-fixture".into();
        config.validate_provider_configs()?;
        assert_eq!(
            config.resolve_batch_provider()?.assembly_ai_key,
            "batch-fixture"
        );
        assert_eq!(
            config.resolve_live_provider()?.assembly_ai_key,
            "live-fixture"
        );
        assert_eq!(config.asr_provider, "assemblyai");
        assert_eq!(config.live_caption_backend, "local_whisper");
        Ok(())
    }

    #[test]
    fn stale_selection_never_falls_back_to_a_different_provider() {
        let mut config = AppConfig::default();
        config.initialize_provider_configs();
        config.live_caption_provider_id = uuid::Uuid::new_v4().to_string();
        assert!(config.resolve_live_provider().is_err());
        assert!(config.validate_provider_configs().is_err());
        assert!(config.resolve_batch_provider().is_ok());
    }
}
