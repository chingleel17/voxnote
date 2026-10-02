import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { detectLocalAsrTools, testLocalAsrConnection } from '../api/settings';
import type { AppConfig, AsrProviderConfig, AsrProviderKind } from '../types';
import { ASR_PROVIDER_OPTIONS } from '../utils/asrProviders';
import { getCurrentConfig } from '../utils/configStore';
import { buildSelectGroup } from './selectGroup';
import { showToast } from './toast';

/** 集中管理供應商連線，不修改批次與即時字幕的模型或語言。 */
export function buildAsrProviderSettings(
  initialConfig: AppConfig,
  onChange: (providers: AsrProviderConfig[]) => void,
): HTMLElement {
  let providers = initialConfig.asr_provider_configs;
  let newKind: AsrProviderKind = 'assemblyai';
  const section = document.createElement('section');
  section.className = 'settings-section asr-provider-settings';
  const heading = document.createElement('h3');
  heading.className = 'settings-section-title';
  heading.textContent = '語音辨識供應商';
  const intro = document.createElement('p');
  intro.className = 'form-hint';
  intro.textContent = '在這裡管理共用金鑰、服務位址與模型檔。批次轉錄與即時字幕可選同一組，也可各自使用不同設定。';
  const cards = document.createElement('div');
  cards.className = 'asr-provider-cards';
  section.append(heading, intro, cards);

  const commit = (): void => onChange(providers);
  const update = (id: string, values: Partial<AsrProviderConfig>): void => {
    providers = providers.map((provider) => provider.id === id ? { ...provider, ...values } : provider);
    commit();
  };
  const inputGroup = (
    provider: AsrProviderConfig,
    field: 'name' | 'api_key' | 'base_url' | 'live_base_url' | 'local_model_path',
    labelText: string,
    type = 'text',
  ): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.className = 'form-control';
    input.type = type;
    input.id = `provider-${provider.id}-${field}`;
    label.htmlFor = input.id;
    input.value = provider[field];
    if (type === 'password') input.autocomplete = 'new-password';
    input.addEventListener('input', () => update(provider.id, { [field]: input.value }));
    group.append(label, input);
    return group;
  };

  const renderCards = (): void => {
    cards.replaceChildren();
    for (const provider of providers) {
      const card = document.createElement('details');
      card.className = 'settings-inline-details asr-provider-card';
      card.dataset.providerId = provider.id;
      const current = getCurrentConfig() ?? initialConfig;
      card.open = provider.id === current.asr_provider_id || provider.id === current.live_caption_provider_id;
      const summary = document.createElement('summary');
      summary.textContent = `${provider.name} · ${ASR_PROVIDER_OPTIONS.find((option) => option.value === provider.kind)?.label}`;
      const body = document.createElement('div');
      body.className = 'settings-inline-body';
      const nameGroup = inputGroup(provider, 'name', '設定名稱');
      nameGroup.querySelector('input')?.addEventListener('input', (event) => {
        summary.textContent = `${(event.target as HTMLInputElement).value} · ${ASR_PROVIDER_OPTIONS.find((option) => option.value === provider.kind)?.label}`;
      });
      body.appendChild(nameGroup);
      if (provider.kind === 'assemblyai') {
        body.appendChild(inputGroup(provider, 'api_key', 'AssemblyAI API Key', 'password'));
        const hint = document.createElement('small');
        hint.className = 'form-hint';
        hint.textContent = '此金鑰供批次轉錄與即時串流共用；串流模型由即時字幕頁獨立選擇。';
        body.appendChild(hint);
      } else if (provider.kind === 'voxnote_asr') {
        body.append(inputGroup(provider, 'base_url', 'Base URL', 'url'),
          inputGroup(provider, 'live_base_url', '即時字幕 URL（選填）', 'url'));
        const hint = document.createElement('small');
        hint.className = 'form-hint';
        hint.textContent = '即時 URL 留空時，在啟動字幕時探測 Base URL 的 /live 端點；模型由服務端配置。';
        const testButton = document.createElement('button');
        testButton.type = 'button';
        testButton.className = 'btn btn-secondary btn-sm';
        testButton.textContent = '測試連線';
        testButton.addEventListener('click', async () => {
          testButton.disabled = true;
          try {
            const profile = providers.find((item) => item.id === provider.id);
            const reachable = await testLocalAsrConnection(profile?.base_url ?? '');
            showToast(reachable ? 'ASR 服務連線成功' : 'ASR 服務未通過健康檢查', reachable ? 'success' : 'error');
          } catch (error) {
            showToast(`ASR 服務連線失敗：${String(error)}`, 'error');
          } finally {
            testButton.disabled = false;
          }
        });
        body.append(hint, testButton);
      } else {
        const modelGroup = inputGroup(provider, 'local_model_path', '即時字幕 GGML 模型檔（.bin）');
        const modelInput = modelGroup.querySelector('input')!;
        const pickButton = document.createElement('button');
        pickButton.type = 'button';
        pickButton.className = 'btn btn-secondary btn-sm';
        pickButton.textContent = '選擇模型檔';
        pickButton.addEventListener('click', async () => {
          const selected = await openDialog({
            multiple: false,
            title: '選擇即時字幕 GGML 模型',
            filters: [{ name: 'Whisper GGML 模型', extensions: ['bin'] }],
          });
          if (typeof selected === 'string') {
            modelInput.value = selected;
            update(provider.id, { local_model_path: selected });
          }
        });
        modelGroup.appendChild(pickButton);
        const detectButton = document.createElement('button');
        detectButton.type = 'button';
        detectButton.className = 'btn btn-secondary btn-sm';
        detectButton.textContent = '偵測批次 Whisper 工具';
        const result = document.createElement('small');
        result.className = 'form-hint';
        result.setAttribute('role', 'status');
        result.textContent = '批次轉錄使用 PATH 中的 Whisper；即時字幕使用上方 GGML 模型檔。';
        detectButton.addEventListener('click', async () => {
          detectButton.disabled = true;
          try {
            const tools = await detectLocalAsrTools();
            result.textContent = tools.length ? tools.map((tool) => `${tool.engine} ${tool.version}`).join('、') : '未偵測到批次 Whisper 工具。';
          } catch {
            result.textContent = '無法偵測批次 Whisper 工具。';
          } finally {
            detectButton.disabled = false;
          }
        });
        body.append(modelGroup, detectButton, result);
      }
      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'btn btn-ghost btn-sm';
      deleteButton.textContent = '刪除供應商設定';
      deleteButton.dataset.deleteProviderId = provider.id;
      deleteButton.disabled = provider.id === current.asr_provider_id || provider.id === current.live_caption_provider_id;
      if (deleteButton.disabled) deleteButton.title = '請先將使用此設定的服務切換到其他供應商';
      deleteButton.addEventListener('click', () => {
        const latest = getCurrentConfig() ?? initialConfig;
        if (provider.id === latest.asr_provider_id || provider.id === latest.live_caption_provider_id) {
          showToast('請先切換使用此設定的服務，再刪除此供應商。', 'warning');
          return;
        }
        providers = providers.filter((item) => item.id !== provider.id);
        commit();
        renderCards();
      });
      body.appendChild(deleteButton);
      card.append(summary, body);
      cards.appendChild(card);
    }
  };
  const addControls = document.createElement('div');
  addControls.className = 'asr-provider-add';
  addControls.appendChild(buildSelectGroup('新增供應商類型', ASR_PROVIDER_OPTIONS, newKind, (value) => {
    newKind = value as AsrProviderKind;
  }));
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'btn btn-secondary';
  addButton.textContent = '新增供應商設定';
  addButton.addEventListener('click', () => {
    const name = ASR_PROVIDER_OPTIONS.find((option) => option.value === newKind)?.label ?? newKind;
    const id = crypto.randomUUID();
    providers = [...providers, { id, name: `${name} ${providers.filter((provider) => provider.kind === newKind).length + 1}`,
      kind: newKind, api_key: '', base_url: '', live_base_url: '', local_model_path: '' }];
    commit();
    renderCards();
    const card = cards.querySelector<HTMLDetailsElement>(`[data-provider-id="${id}"]`);
    if (card) {
      card.open = true;
      card.querySelector('input')?.focus();
    }
  });
  addControls.appendChild(addButton);
  section.appendChild(addControls);
  renderCards();
  return section;
}

export function refreshAsrProviderUsage(section: HTMLElement, config: AppConfig): void {
  for (const button of section.querySelectorAll<HTMLButtonElement>('[data-delete-provider-id]')) {
    button.disabled = button.dataset.deleteProviderId === config.asr_provider_id
      || button.dataset.deleteProviderId === config.live_caption_provider_id;
    button.title = button.disabled ? '請先將使用此設定的服務切換到其他供應商' : '';
  }
}
