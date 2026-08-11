export interface ProofreadResult {
  content: string;
  warning: string | null;
}

export interface Category {
  id: string;
  name: string;
  created_at: string;
}

export interface Meeting {
  id: string;
  title: string;
  category_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MeetingWithDetails {
  id: string;
  title: string;
  category_id: string | null;
  category_name: string | null;
  participants: string[];
  has_transcript: boolean;
  has_summary: boolean;
  tags: Tag[];
  meeting_date: string | null;
  archived_at: string | null;
  archived_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Transcript {
  id: string;
  meeting_id: string;
  original_content: string | null;
  proofread_content: string | null;
  proofread_status: 'idle' | 'running' | 'completed' | 'failed' | 'interrupted';
  proofread_error: string | null;
  proofread_warning: string | null;
  proofread_started_at: string | null;
  manual_content: string | null;
  manual_base_version: 'original' | 'proofread' | null;
  manual_updated_at: string | null;
  active_version: 'original' | 'proofread' | 'manual';
  proofread_provider: string | null;
  proofread_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SpeakerMapping {
  id: string;
  meeting_id: string;
  recording_id: string | null;
  speaker_label: string;
  participant_name: string;
  created_at: string;
  updated_at: string;
}

export interface Summary {
  id: string;
  meeting_id: string;
  content: string;
  provider: string | null;
  created_at: string;
}

export interface Recording {
  id: string;
  meeting_id: string;
  file_path: string | null;
  original_file_name: string | null;
  duration_seconds: number | null;
  source_mode: RecordingSourceMode | null;
  sort_order: number;
  segment_transcript: string | null;
  segment_proofread: string | null;
  no_break_before: number;
  created_at: string;
}

export type RecordingSourceMode = 'microphone' | 'system' | 'mix';

export interface RecordingDevice {
  id: string;
  name: string;
  is_default: boolean;
}

export interface RecordingDeviceList {
  microphones: RecordingDevice[];
  system_outputs: RecordingDevice[];
  system_audio_supported: boolean;
}

export interface RecordingPreview {
  temp_file_path: string;
  duration_seconds: number;
  mode: RecordingSourceMode;
  warning: string | null;
}

export interface LiveCaptionStatus {
  active: boolean;
  backend: 'local_whisper' | 'voxnote_asr' | null;
  audio_source: 'microphone' | 'system' | null;
}

export interface LiveCaptionPayload {
  sequence: number;
  original: string;
  translation: string | null;
  display_text: string;
}

export interface LiveCaptionErrorPayload {
  message: string;
}

export interface LiveCaptionSettingsPayload {
  font_size: number;
  clear_seconds: number;
  click_through: boolean;
}

export interface LiveCaptionBuildInfo {
  cuda_enabled: boolean;
}

export interface AppConfig {
  // ASR
  asr_provider: 'assemblyai' | 'local' | 'voxnote_asr';
  assembly_ai_key: string;
  assembly_ai_speech_model: 'universal-2' | 'universal-3-pro';
  recording_storage_dir: string;
  archive_storage_dir: string;
  recording_source_mode: RecordingSourceMode;
  recording_microphone_device_id: string;
  recording_system_device_id: string;
  local_asr_model: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  local_asr_base_url: string;
  asr_language: string;       // "zh" | "en" | "auto"
  speaker_detection: boolean; // 說話人偵測
  auto_proofread_after_transcription: boolean; // 逐段轉譯完成後自動 AI 校稿

  // 即時字幕
  live_caption_backend: 'local_whisper' | 'voxnote_asr';
  live_caption_model_path: string;
  live_caption_audio_source: 'microphone' | 'system';
  live_caption_window_seconds: number;
  live_caption_step_seconds: number;
  live_caption_silence_threshold: number;
  live_caption_translate: boolean;
  live_caption_display_mode: 'translation' | 'original' | 'both';
  live_caption_font_size: number; // 僅接受 S/M/L/XL 四檔預設值，見 liveCaptionSettings.ts
  live_caption_clear_seconds: number;
  live_caption_click_through: boolean;
  // 即時字幕來源語言與遠端端點，與批次流程（asr_language / local_asr_base_url）各自獨立
  live_caption_language: string; // "zh" | "en" | "auto"
  live_caption_remote_base_url: string; // 空字串代表沿用 local_asr_base_url
  live_caption_remote_model: string;
  live_caption_remote_timeout_seconds: number;

  // 播放增益（會議錄音響度通常低於一般影音內容）
  playback_gain: number;         // 增益倍率，1.0 為原始音量
  playback_compressor: boolean;  // 動態壓縮
  playback_highpass: boolean;    // 高通濾波

  // LLM
  llm_provider: 'openai' | 'claude' | 'gemini' | 'openrouter' | 'ollama' | 'custom';
  openai_key: string;
  openai_model: string;
  claude_key: string;
  claude_model: string;
  gemini_key: string;
  gemini_model: string;
  openrouter_key: string;
  openrouter_model: string;
  ollama_endpoint: string;
  ollama_model: string;
  ollama_think_level: 'off' | 'low' | 'medium' | 'high';
  custom_endpoint: string;
  custom_api_key: string;
  custom_model: string;

  // AI Prompt 自訂（空字串代表使用內建預設 Prompt）
  proofread_prompt: string;
  summary_prompt: string;

  // 完成通知
  completion_notification_enabled: boolean;
}

export interface SavedParticipant {
  id: string;
  name: string;
  usage_count: number;
  created_at: string;
}

export interface MeetingTemplate {
  id: string;
  name: string;
  title: string;
  category_id: string | null;
  participants: string[];
  created_at: string;
}

export interface CreateTemplateRequest {
  name: string;
  title: string;
  category_id: string | null;
  participants: string[];
}

export interface UpdateTemplateRequest {
  name: string;
  title: string;
  participants: string[];
}

export interface CreateMeetingRequest {
  title: string;
  category_id: string | null;
  participants: string[];
  tag_ids?: string[];
}

export interface UpdateMeetingRequest {
  title: string;
  category_id: string | null;
  participants: string[];
  tag_ids?: string[];
  meeting_date?: string | null;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface ExportTextFile {
  fileName: string;
  content: string;
}

export interface MeetingExportResult {
  outputPath: string | null;
  written: number;
  skipped: string[];
  alreadyExists: boolean;
}

export type BackupImportMode = 'merge' | 'overwrite';

export interface BackupResult {
  outputPath: string | null;
  added: number;
  skipped: number;
  reused: number;
  warnings: string[];
}

export interface BackupPreflightResult {
  summary: {
    createdAt: string;
    meetings: number;
    recordings: number;
    assets: number;
  };
  warnings: string[];
}
