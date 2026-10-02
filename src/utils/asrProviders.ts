import type { AppConfig, AsrProviderConfig, AsrProviderKind } from '../types';

export const ASR_PROVIDER_OPTIONS: Array<{ value: AsrProviderKind; label: string }> = [
  { value: 'assemblyai', label: 'AssemblyAI（雲端）' },
  { value: 'voxnote_asr', label: 'VoxNote 自架 ASR' },
  { value: 'local', label: '本地 Whisper' },
];
export const ASSEMBLYAI_BATCH_MODELS = ['universal-2', 'universal-3-5-pro'];
export const ASSEMBLYAI_STREAM_MODELS = ['universal-3-6-pro', 'universal-3-5-pro'];
export const LOCAL_ASR_MODELS = ['tiny', 'base', 'small', 'medium', 'large'];

export function getSelectedAsrProvider(config: AppConfig, service: 'batch' | 'live'): AsrProviderConfig | undefined {
  const id = service === 'batch' ? config.asr_provider_id : config.live_caption_provider_id;
  return config.asr_provider_configs.find((provider) => provider.id === id);
}

export function selectAsrProvider(config: AppConfig, service: 'batch' | 'live', id: string): AppConfig {
  const provider = config.asr_provider_configs.find((provider) => provider.id === id);
  if (!provider) throw new Error('供應商設定不存在，請至設定頁重新選擇');
  if (service === 'batch') {
    return { ...config, asr_provider_id: id, asr_provider: provider.kind };
  }
  const backend = provider.kind === 'assemblyai' ? 'assemblyai_streaming'
    : provider.kind === 'local' ? 'local_whisper' : 'voxnote_asr';
  return { ...config, live_caption_provider_id: id, live_caption_backend: backend };
}
