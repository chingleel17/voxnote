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
  sort_order: number;
  segment_transcript: string | null;
  segment_proofread: string | null;
  no_break_before: number;
  created_at: string;
}

export interface AppConfig {
  // ASR
  asr_provider: 'assemblyai' | 'local';
  assembly_ai_key: string;
  local_asr_model: 'tiny' | 'base' | 'small' | 'medium' | 'large';
  asr_language: string;       // "zh" | "en" | "auto"
  speaker_detection: boolean; // 說話人偵測

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
