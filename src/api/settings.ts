import { invoke } from '@tauri-apps/api/core';
import type { AppConfig } from '../types';

export const getSettings = () => invoke<AppConfig>('get_settings');
export const saveSettings = (config: AppConfig) => invoke<void>('save_settings', { config });
export const testOllamaConnection = (endpoint: string) => invoke<boolean>('test_ollama_connection', { endpoint });
export const getOllamaModels = (endpoint: string) => invoke<string[]>('get_ollama_models', { endpoint });
