import type { AppConfig } from '../types';

/** 只合併字幕服務選項，供應商連線資訊始終採用最新完整設定。 */
export function mergeLiveCaptionSettings(latest: AppConfig, caption: AppConfig): AppConfig {
  return {
    ...latest,
    live_caption_provider_id: caption.live_caption_provider_id,
    live_caption_backend: caption.live_caption_backend,
    live_caption_assemblyai_model: caption.live_caption_assemblyai_model,
    live_caption_language: caption.live_caption_language,
    live_caption_remote_timeout_seconds: caption.live_caption_remote_timeout_seconds,
    live_caption_audio_source: caption.live_caption_audio_source,
    live_caption_window_seconds: caption.live_caption_window_seconds,
    live_caption_step_seconds: caption.live_caption_step_seconds,
    live_caption_incremental_enabled: caption.live_caption_incremental_enabled,
    live_caption_decode_interval_ms: caption.live_caption_decode_interval_ms,
    live_caption_silence_threshold: caption.live_caption_silence_threshold,
    live_caption_translate: caption.live_caption_translate,
    live_caption_proofread: caption.live_caption_proofread,
    live_caption_display_mode: caption.live_caption_display_mode,
    live_caption_font_size: caption.live_caption_font_size,
    live_caption_clear_seconds: caption.live_caption_clear_seconds,
    live_caption_click_through: caption.live_caption_click_through,
  };
}
