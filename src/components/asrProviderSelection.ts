import type { AppConfig, AsrProviderSelection } from '../types';
import {
  ASSEMBLYAI_BATCH_MODELS, ASSEMBLYAI_STREAM_MODELS, LOCAL_ASR_MODELS,
  getSelectedAsrProvider, selectAsrProvider,
} from '../utils/asrProviders';
import { buildSelectGroup } from './selectGroup';

/** 服務端只選供應商與模型；連線資訊集中於設定頁。 */
export function buildAsrProviderSelection(
  initialConfig: AppConfig,
  service: 'batch' | 'live',
  onChange: (config: AppConfig) => void,
): AsrProviderSelection {
  let config = initialConfig;
  const container = document.createElement('div');
  container.dataset.asrProviderSelection = service;
  const modelContainer = document.createElement('div');
  const renderModel = (): void => {
    modelContainer.replaceChildren();
    const provider = getSelectedAsrProvider(config, service);
    if (provider?.kind === 'assemblyai') {
      const models = service === 'batch' ? ASSEMBLYAI_BATCH_MODELS : ASSEMBLYAI_STREAM_MODELS;
      const value = service === 'batch' ? config.assembly_ai_speech_model : config.live_caption_assemblyai_model;
      modelContainer.appendChild(buildSelectGroup('模型', models.map((model) => ({ value: model, label: model })), value, (model) => {
        config = service === 'batch' ? { ...config, assembly_ai_speech_model: model }
          : { ...config, live_caption_assemblyai_model: model };
        onChange(config);
      }, { filterable: true, allowCustom: true }));
    } else if (provider?.kind === 'local' && service === 'batch') {
      modelContainer.appendChild(buildSelectGroup('模型大小', LOCAL_ASR_MODELS.map((model) => ({ value: model, label: model })), config.local_asr_model, (model) => {
        config = { ...config, local_asr_model: model as AppConfig['local_asr_model'] };
        onChange(config);
      }));
    } else {
      const hint = document.createElement('p');
      hint.className = 'form-hint';
      hint.textContent = provider?.kind === 'voxnote_asr' ? '模型由自架服務決定。'
        : provider?.local_model_path ? `模型：${provider.local_model_path.split(/[\\/]/).pop()}`
          : '請至設定頁配置此供應商的即時字幕模型檔。';
      modelContainer.appendChild(hint);
    }
  };
  const providerGroup = buildSelectGroup('供應商設定', config.asr_provider_configs.map((provider) => ({
    value: provider.id,
    label: provider.name,
  })), service === 'batch' ? config.asr_provider_id : config.live_caption_provider_id, (id) => {
    config = selectAsrProvider(config, service, id);
    onChange(config);
    renderModel();
  });
  container.appendChild(providerGroup);
  container.appendChild(modelContainer);
  const settingsLink = document.createElement('a');
  settingsLink.href = '#settings';
  settingsLink.className = 'form-hint';
  settingsLink.textContent = '前往設定頁管理供應商';
  container.appendChild(settingsLink);
  renderModel();
  return Object.assign(container, {
    updateProviders(providers: AppConfig['asr_provider_configs']): void {
      config = { ...config, asr_provider_configs: providers };
      providerGroup.setOptions(providers.map((provider) => ({ value: provider.id, label: provider.name })));
      renderModel();
    },
  });
}
