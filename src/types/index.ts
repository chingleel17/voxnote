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
  created_at: string;
  updated_at: string;
}

export interface Transcript {
  id: string;
  meeting_id: string;
  original_content: string | null;
  proofread_content: string | null;
  active_version: 'original' | 'proofread';
  proofread_provider: string | null;
  proofread_at: string | null;
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
  duration_seconds: number | null;
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
  custom_endpoint: string;
  custom_api_key: string;
  custom_model: string;
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
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: string;
}
