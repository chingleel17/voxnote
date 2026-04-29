export interface Category {
  id: string;
  name: string;
  createdAt: string;
}

export interface Meeting {
  id: string;
  title: string;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingWithDetails {
  id: string;
  title: string;
  categoryId: string | null;
  categoryName: string | null;
  participants: string[];
  hasTranscript: boolean;
  hasSummary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Transcript {
  id: string;
  meetingId: string;
  originalContent: string | null;
  proofreadContent: string | null;
  activeVersion: 'original' | 'proofread';
  proofreadProvider: string | null;
  proofreadAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Summary {
  id: string;
  meetingId: string;
  content: string;
  provider: string | null;
  createdAt: string;
}

export interface Recording {
  id: string;
  meetingId: string;
  filePath: string | null;
  durationSeconds: number | null;
  createdAt: string;
}

export interface AppConfig {
  // ASR
  asr_provider: 'assemblyai' | 'local';
  assembly_ai_key: string;
  local_asr_model: 'tiny' | 'base' | 'small' | 'medium' | 'large';

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

export interface CreateMeetingRequest {
  title: string;
  categoryId: string | null;
  participants: string[];
}

export interface UpdateMeetingRequest {
  title: string;
  categoryId: string | null;
  participants: string[];
}
