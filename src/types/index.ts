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
  asrProvider: 'assemblyai' | 'local';
  assemblyAiKey: string;
  localAsrModel: 'tiny' | 'base' | 'small' | 'medium' | 'large';

  // LLM
  llmProvider: 'openai' | 'claude' | 'gemini' | 'openrouter' | 'ollama' | 'custom';
  openaiKey: string;
  openaiModel: string;
  claudeKey: string;
  claudeModel: string;
  geminiKey: string;
  geminiModel: string;
  openrouterKey: string;
  openrouterModel: string;
  ollamaEndpoint: string;
  ollamaModel: string;
  customEndpoint: string;
  customApiKey: string;
  customModel: string;
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
