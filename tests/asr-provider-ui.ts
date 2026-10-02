import type { AppConfig, LiveCaptionStatus } from '../src/types';
import { buildSelectGroup } from '../src/components/selectGroup';
import { renderSettingsPage } from '../src/pages/settings';
import { renderLiveCaptionPage } from '../src/pages/liveCaption';
import { getCurrentConfig, setCurrentConfig } from '../src/utils/configStore';

// 僅使用假設定及 IPC；不讀取桌面 AppData、不連接 ASR 或 LLM。
const fixtureConfig = {
  asr_provider: 'assemblyai', asr_provider_id: 'assembly', live_caption_provider_id: 'local',
  asr_provider_configs: [
    { id: 'assembly', name: '雲端帳戶', kind: 'assemblyai', api_key: 'fixture-only', base_url: '', live_base_url: '', local_model_path: '' },
    { id: 'remote', name: '自架服務', kind: 'voxnote_asr', api_key: '', base_url: 'http://localhost:8000', live_base_url: '', local_model_path: '' },
    { id: 'local', name: '本地 Whisper', kind: 'local', api_key: '', base_url: '', live_base_url: '', local_model_path: 'C:\\fixtures\\model.bin' },
  ],
  assembly_ai_key: 'legacy-fixture-only', assembly_ai_speech_model: 'universal-2',
  local_asr_model: 'base', local_asr_base_url: 'http://localhost:8000', asr_language: 'zh',
  speaker_detection: true, auto_proofread_after_transcription: false, voiceprint_similarity_threshold: 0.25,
  live_caption_backend: 'local_whisper', live_caption_assemblyai_model: 'universal-3-6-pro',
  live_caption_model_path: '', live_caption_language: 'auto', live_caption_remote_base_url: '', live_caption_remote_model: '',
  live_caption_audio_source: 'system', live_caption_window_seconds: 5, live_caption_step_seconds: 3,
  live_caption_incremental_enabled: true, live_caption_decode_interval_ms: 800, live_caption_silence_threshold: 0.01,
  live_caption_remote_timeout_seconds: 8, live_caption_translate: true, live_caption_proofread: false,
  live_caption_display_mode: 'both', live_caption_font_size: 28, live_caption_clear_seconds: 8, live_caption_click_through: true,
  llm_provider: 'ollama', ollama_endpoint: 'http://localhost:11434', ollama_model: 'fixture-model', ollama_think_level: 'low',
  openai_key: '', openai_model: '', claude_key: '', claude_model: '', gemini_key: '', gemini_model: '',
  openrouter_key: '', openrouter_model: '', custom_endpoint: '', custom_api_key: '', custom_model: '',
  playback_gain: 2, playback_compressor: true, playback_highpass: true,
  proofread_prompt: '', summary_prompt: '', recording_storage_dir: '', archive_storage_dir: '',
  completion_notification_enabled: false,
} as AppConfig;

let saved: AppConfig | null = null;
let liveStatus: LiveCaptionStatus = { active: false, backend: null, audio_source: null, session_id: null };
let callbackId = 0;
let startCalls = 0;
Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: () => ++callbackId,
    unregisterCallback: () => undefined,
    invoke: async (command: string, args?: { config?: AppConfig }): Promise<unknown> => {
      if (command === 'get_settings') return structuredClone(fixtureConfig);
      if (command === 'save_settings') {
        saved = structuredClone(args?.config ?? fixtureConfig);
        return;
      }
      if (command === 'get_live_caption_status') return liveStatus;
      if (command === 'get_live_caption_build_info') return { cuda_enabled: false };
      if (command === 'list_live_caption_audio_sources') return { microphones: [], system_outputs: [], system_audio_supported: true };
      if (command === 'start_live_caption') {
        startCalls += 1;
        liveStatus = { active: true, backend: 'assemblyai_streaming', audio_source: 'system', session_id: 'fixture-session' };
        return liveStatus;
      }
      if (command === 'stop_live_caption') {
        liveStatus = { ...liveStatus, active: false };
        return liveStatus;
      }
      if (command === 'plugin:event|listen') return ++callbackId;
      if (command === 'list_provider_models') return [];
      return undefined;
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
});

const results: string[] = [];
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function change(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
function input(element: HTMLInputElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
function selectByLabel(root: ParentNode, text: string): HTMLSelectElement {
  const label = Array.from(root.querySelectorAll('label')).find((item) => item.textContent === text);
  assert(label?.htmlFor, `找不到共用欄位：${text}`);
  const select = root.querySelector<HTMLSelectElement>(`#${label.htmlFor}`);
  assert(select, `找不到下拉欄位：${text}`);
  return select;
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

async function run(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#fixture')!;
  let changed = '';
  const group = buildSelectGroup('測試模型', [{ value: 'known', label: 'known' }], 'manual-existing', (value) => { changed = value; }, { filterable: true, allowCustom: true });
  root.appendChild(group);
  group.setOptions([{ value: 'next', label: 'next' }]);
  assert(group.select.value === 'manual-existing', '更新清單不應覆寫自訂模型');
  group.querySelector<HTMLButtonElement>('button')!.click();
  input(group.querySelector<HTMLInputElement>('input[type="search"]')!, 'next');
  assert(changed === '', '篩選不應觸發設定變更');
  change(group.select, '__manual_model__');
  input(group.querySelector<HTMLInputElement>('input[type="text"]')!, 'custom-model');
  assert(String(changed) === 'custom-model', '手動模型 ID 應觸發相同更新契約');
  results.push('共用下拉：篩選／保留選值／手動 ID');

  setCurrentConfig(structuredClone(fixtureConfig));
  await renderSettingsPage(root);
  change(selectByLabel(root, '新增供應商類型'), 'voxnote_asr');
  const add = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '新增供應商設定')!;
  add.click();
  let current = getCurrentConfig()!;
  const extra = current.asr_provider_configs[current.asr_provider_configs.length - 1];
  assert(extra.kind === 'voxnote_asr', '應可新增同類供應商');
  const card = root.querySelector<HTMLElement>(`[data-provider-id="${extra.id}"]`)!;
  input(card.querySelector<HTMLInputElement>('[id$="-name"]')!, '第二個自架端點');
  input(card.querySelector<HTMLInputElement>('[id$="-base_url"]')!, 'http://localhost:8002');
  const batch = root.querySelector('[data-asr-provider-selection="batch"]')!;
  change(selectByLabel(batch, '供應商設定'), extra.id);
  current = getCurrentConfig()!;
  assert(current.asr_provider_id === extra.id && current.asr_provider === 'voxnote_asr', '批次應引用新供應商 ID');
  assert(current.live_caption_provider_id === 'local', '批次切換不應修改字幕選擇');
  assert(current.asr_provider_configs[1].base_url === 'http://localhost:8000', '新增設定不應覆寫原 URL');
  assert(card.querySelector<HTMLButtonElement>('[data-delete-provider-id]')!.disabled, '使用中的供應商不得直接刪除');
  await delay(650);
  assert(saved?.asr_provider_configs.length === 4, '自動儲存應保存完整供應商清單');
  results.push('設定頁：新增同類供應商／命名／獨立 URL／自動儲存');

  await renderLiveCaptionPage(root);
  const live = root.querySelector('[data-asr-provider-selection="live"]')!;
  assert(root.querySelector('input[type="password"], input[type="url"], datalist') === null, '字幕頁不得重複配置金鑰或 URL，也不應使用 datalist');
  change(selectByLabel(live, '供應商設定'), 'assembly');
  change(selectByLabel(live, '模型'), 'universal-3-5-pro');
  current = getCurrentConfig()!;
  assert(current.live_caption_assemblyai_model === 'universal-3-5-pro', '字幕應更新獨立模型');
  assert(current.assembly_ai_speech_model === 'universal-2', '字幕模型不可覆寫批次模型');
  assert(root.querySelector<HTMLInputElement>('input[type="number"][step="100"]')!.closest<HTMLElement>('.form-group')!.style.display === 'none', '串流應隱藏增量解碼設定');
  change(selectByLabel(live, '供應商設定'), 'local');
  assert(getCurrentConfig()!.live_caption_decode_interval_ms === 800, '切回本地應保留解碼間隔');
  assert(getCurrentConfig()!.live_caption_window_seconds === 5
    && getCurrentConfig()!.live_caption_step_seconds === 3
    && getCurrentConfig()!.live_caption_incremental_enabled === true, '來源切換應保留視窗與增量原值');
  change(selectByLabel(live, '供應商設定'), 'assembly');
  results.push('字幕頁：供應商／模型共用元件與來源切換');

  const latest = structuredClone(getCurrentConfig()!);
  latest.asr_provider_configs[0].api_key = 'new-fixture-only';
  latest.ollama_model = 'latest-llm';
  setCurrentConfig(latest);
  const start = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '開始即時字幕')!;
  start.click();
  await delay(50);
  assert(startCalls === 1, '開始動作應呼叫字幕 API');
  assert(saved?.asr_provider_configs[0].api_key === latest.asr_provider_configs[0].api_key, '字幕儲存不應以舊快照覆寫金鑰');
  assert(saved?.ollama_model === 'latest-llm', '字幕儲存不應回退其他設定');
  change(selectByLabel(root, '字幕字級'), '36');
  assert(!root.querySelector<HTMLElement>('.live-caption-restart-hint')!.hidden, '執行中變更設定應顯示重啟提示');
  const stop = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '停止字幕')!;
  stop.click();
  await delay(20);
  assert(!selectByLabel(root, '音訊來源').disabled, '停止後應恢復音源選擇');
  results.push('字幕開始：保留最新完整設定與重啟提示');
}

void run().then(() => {
  const result = { passed: results.length, checks: results };
  Object.assign(window, { __asrProviderUiResult: result });
  document.querySelector('#result')!.textContent = JSON.stringify(result, null, 2);
}).catch((error: unknown) => {
  const result = { failed: String(error), completed: results };
  Object.assign(window, { __asrProviderUiResult: result });
  document.querySelector('#result')!.textContent = JSON.stringify(result, null, 2);
});
