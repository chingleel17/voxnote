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
  providerMode: 'cloud' | 'hybrid' | 'ollama';
  assemblyAiKey: string;
  geminiKey: string;
  geminiModel: string;
  ollamaEndpoint: string;
  ollamaLlmModel: string;
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
