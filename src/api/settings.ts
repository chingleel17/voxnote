import { invoke } from '@tauri-apps/api/core';
import type { AppConfig } from '../types';

export interface LocalAsrInfo {
  engine: string;
  version: string;
  available: boolean;
}

export const getSettings = () => invoke<AppConfig>('get_settings');
export const saveSettings = (config: AppConfig) => invoke<void>('save_settings', { config });
export const testLlmConnection = () => invoke<string>('test_llm_connection_cmd');
export const testOllamaConnection = (endpoint: string) => invoke<boolean>('test_ollama_connection', { endpoint });
export const getOllamaModels = (endpoint: string) => invoke<string[]>('get_ollama_models', { endpoint });
export const detectLocalAsrTools = () => invoke<LocalAsrInfo[]>('detect_local_asr_tools');
export const startTranscription = (meetingId: string, filePath: string) =>
  invoke<string>('start_transcription', { meetingId, filePath });
export const proofreadTranscript = (meetingId: string) =>
  invoke<string>('proofread_transcript', { meetingId });
export const generateSummary = (meetingId: string) =>
  invoke<string>('generate_summary', { meetingId });
