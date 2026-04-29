import type { AppConfig } from '../types';
import {
  getSettings, saveSettings,
  testLlmConnection, testOllamaConnection, getOllamaModels,
  detectLocalAsrTools,
  type LocalAsrInfo,
} from '../api/settings';
import { showToast } from '../components/toast';

// ─────────────────────────────────────────────
// 預設模型選項
// ─────────────────────────────────────────────
const OPENAI_MODELS = ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'];
const CLAUDE_MODELS = [
  'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-20241022',
  'claude-3-opus-20240229',
];
const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
const LOCAL_ASR_MODELS = ['tiny', 'base', 'small', 'medium', 'large'];

// ─────────────────────────────────────────────
// 主要渲染函式
// ─────────────────────────────────────────────
export async function renderSettingsPage(container: HTMLElement): Promise<void> {
  container.innerHTML = '<div class="loading">載入設定中...</div>';

  let config: AppConfig;
  try {
    config = await getSettings();
  } catch (err) {
    container.innerHTML = `<div class="error-state">載入設定失敗：${String(err)}</div>`;
    return;
  }

  container.innerHTML = '';

  // 標題
  const toolbar = document.createElement('div');
  toolbar.className = 'page-toolbar';
  const pageTitle = document.createElement('h2');
  pageTitle.className = 'page-title';
  pageTitle.textContent = '設定';
  toolbar.appendChild(pageTitle);
  container.appendChild(toolbar);

  const form = document.createElement('form');
  form.className = 'settings-form';
  form.addEventListener('submit', (e) => e.preventDefault());
  container.appendChild(form);

  // ── ASR 區塊 ──
  const asrSection = buildAsrSection(config, (updated) => { config = updated; });
  form.appendChild(asrSection);

  // ── LLM 區塊 ──
  const llmSection = buildLlmSection(config, (updated) => { config = updated; });
  form.appendChild(llmSection);

  // ── 儲存按鈕 ──
  const saveRow = document.createElement('div');
  saveRow.className = 'settings-save-row';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = '儲存設定';
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await saveSettings(config);
      showToast('設定已儲存', 'success');
    } catch (err) {
      showToast(`儲存失敗：${String(err)}`, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });
  saveRow.appendChild(saveBtn);
  form.appendChild(saveRow);
}

// ─────────────────────────────────────────────
// ASR 區塊
// ─────────────────────────────────────────────
function buildAsrSection(
  config: AppConfig,
  onChange: (c: AppConfig) => void
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'settings-section';

  const heading = document.createElement('h3');
  heading.className = 'settings-section-title';
  heading.textContent = '語音轉錄（ASR）';
  section.appendChild(heading);

  // 供應商下拉
  const providerGroup = buildSelectGroup(
    '轉錄供應商',
    [
      { value: 'assemblyai', label: 'AssemblyAI（雲端）' },
      { value: 'local', label: '本地 Whisper' },
    ],
    config.asrProvider,
    (v) => {
      config = { ...config, asrProvider: v as AppConfig['asrProvider'] };
      onChange(config);
      updateAsrVisibility(v);
    }
  );
  section.appendChild(providerGroup);

  // AssemblyAI Key
  const assemblySection = document.createElement('div');
  assemblySection.appendChild(
    buildInputGroup('AssemblyAI API Key', 'password', config.assemblyAiKey, (v) => {
      config = { ...config, assemblyAiKey: v };
      onChange(config);
    })
  );
  section.appendChild(assemblySection);

  // 本地 Whisper
  const localSection = document.createElement('div');
  const localStatus = document.createElement('div');
  localStatus.className = 'form-group';
  localStatus.innerHTML = '<label>偵測狀態</label><div class="asr-detect-result">正在偵測...</div>';
  localSection.appendChild(localStatus);

  const detectBtn = document.createElement('button');
  detectBtn.className = 'btn btn-secondary btn-sm';
  detectBtn.textContent = '重新偵測';
  detectBtn.style.marginBottom = '12px';
  localSection.appendChild(detectBtn);

  localSection.appendChild(
    buildSelectGroup(
      '模型大小',
      LOCAL_ASR_MODELS.map((m) => ({ value: m, label: m })),
      config.localAsrModel,
      (v) => {
        config = { ...config, localAsrModel: v as AppConfig['localAsrModel'] };
        onChange(config);
      }
    )
  );
  section.appendChild(localSection);

  // 偵測邏輯
  const resultEl = localSection.querySelector('.asr-detect-result') as HTMLElement;
  const runDetect = async (): Promise<void> => {
    resultEl.textContent = '偵測中...';
    detectBtn.disabled = true;
    try {
      const tools: LocalAsrInfo[] = await detectLocalAsrTools();
      if (tools.length > 0) {
        resultEl.innerHTML = tools
          .map((t) => `<span class="badge badge-success">✓ ${t.engine} ${t.version}</span>`)
          .join(' ');
      } else {
        resultEl.innerHTML = `
          <span class="badge badge-warning">未偵測到 Whisper</span>
          <div class="asr-install-hint">建議安裝：<code>pipx install openai-whisper</code>（不污染全域 Python）</div>
        `;
      }
    } catch {
      resultEl.textContent = '偵測失敗';
    } finally {
      detectBtn.disabled = false;
    }
  };
  detectBtn.addEventListener('click', () => void runDetect());
  void runDetect();

  // 可見性控制
  const updateAsrVisibility = (provider: string): void => {
    assemblySection.style.display = provider === 'assemblyai' ? '' : 'none';
    localSection.style.display = provider === 'local' ? '' : 'none';
  };
  updateAsrVisibility(config.asrProvider);

  return section;
}

// ─────────────────────────────────────────────
// LLM 區塊
// ─────────────────────────────────────────────
function buildLlmSection(
  config: AppConfig,
  onChange: (c: AppConfig) => void
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'settings-section';

  const heading = document.createElement('h3');
  heading.className = 'settings-section-title';
  heading.textContent = 'AI 語言模型（LLM）';
  section.appendChild(heading);

  // 供應商下拉
  const providers = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'claude', label: 'Claude（Anthropic）' },
    { value: 'gemini', label: 'Gemini（Google）' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'ollama', label: 'Ollama（本地）' },
    { value: 'custom', label: '自訂端點' },
  ];

  const providerGroup = buildSelectGroup(
    'LLM 供應商',
    providers,
    config.llmProvider,
    (v) => {
      config = { ...config, llmProvider: v as AppConfig['llmProvider'] };
      onChange(config);
      updateLlmVisibility(v);
    }
  );
  section.appendChild(providerGroup);

  // ── OpenAI ──
  const openaiSection = buildProviderSection([
    buildInputGroup('OpenAI API Key', 'password', config.openaiKey, (v) => {
      config = { ...config, openaiKey: v }; onChange(config);
    }),
    buildSelectGroup('模型', OPENAI_MODELS.map((m) => ({ value: m, label: m })), config.openaiModel, (v) => {
      config = { ...config, openaiModel: v }; onChange(config);
    }),
  ]);
  section.appendChild(openaiSection);

  // ── Claude ──
  const claudeSection = buildProviderSection([
    buildInputGroup('Claude API Key', 'password', config.claudeKey, (v) => {
      config = { ...config, claudeKey: v }; onChange(config);
    }),
    buildSelectGroup('模型', CLAUDE_MODELS.map((m) => ({ value: m, label: m })), config.claudeModel, (v) => {
      config = { ...config, claudeModel: v }; onChange(config);
    }),
  ]);
  section.appendChild(claudeSection);

  // ── Gemini ──
  const geminiSection = buildProviderSection([
    buildInputGroup('Gemini API Key', 'password', config.geminiKey, (v) => {
      config = { ...config, geminiKey: v }; onChange(config);
    }),
    buildSelectGroup('模型', GEMINI_MODELS.map((m) => ({ value: m, label: m })), config.geminiModel, (v) => {
      config = { ...config, geminiModel: v }; onChange(config);
    }),
  ]);
  section.appendChild(geminiSection);

  // ── OpenRouter ──
  const openrouterSection = buildProviderSection([
    buildInputGroup('OpenRouter API Key', 'password', config.openrouterKey, (v) => {
      config = { ...config, openrouterKey: v }; onChange(config);
    }),
    buildInputGroup('模型（例如：openai/gpt-4o-mini）', 'text', config.openrouterModel, (v) => {
      config = { ...config, openrouterModel: v }; onChange(config);
    }),
  ]);
  section.appendChild(openrouterSection);

  // ── Ollama ──
  const ollamaSection = buildOllamaSection(config, (updated) => {
    config = updated;
    onChange(config);
  });
  section.appendChild(ollamaSection);

  // ── 自訂端點 ──
  const customSection = buildProviderSection([
    buildInputGroup('API Endpoint（OpenAI-compatible）', 'text', config.customEndpoint, (v) => {
      config = { ...config, customEndpoint: v }; onChange(config);
    }),
    buildInputGroup('API Key（可留空）', 'password', config.customApiKey, (v) => {
      config = { ...config, customApiKey: v }; onChange(config);
    }),
    buildInputGroup('模型名稱', 'text', config.customModel, (v) => {
      config = { ...config, customModel: v }; onChange(config);
    }),
  ]);
  section.appendChild(customSection);

  // 測試連線按鈕（通用）
  const testRow = document.createElement('div');
  testRow.className = 'settings-test-row';
  const testBtn = document.createElement('button');
  testBtn.className = 'btn btn-secondary btn-sm';
  testBtn.textContent = '測試 LLM 連線';
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = '測試中...';
    try {
      onChange(config);
      // 儲存後測試
      const result = await testLlmConnection();
      showToast(`連線成功：${result}`, 'success');
    } catch (err) {
      showToast(`連線失敗：${String(err)}`, 'error');
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '測試 LLM 連線';
    }
  });
  testRow.appendChild(testBtn);
  section.appendChild(testRow);

  // 可見性控制
  const allSections = [
    openaiSection, claudeSection, geminiSection,
    openrouterSection, ollamaSection, customSection,
  ];
  const providerMap: Record<string, HTMLElement> = {
    openai: openaiSection,
    claude: claudeSection,
    gemini: geminiSection,
    openrouter: openrouterSection,
    ollama: ollamaSection,
    custom: customSection,
  };

  const updateLlmVisibility = (provider: string): void => {
    for (const el of allSections) el.style.display = 'none';
    if (providerMap[provider]) providerMap[provider].style.display = '';
  };
  updateLlmVisibility(config.llmProvider);

  return section;
}

// ─────────────────────────────────────────────
// Ollama 子區塊（保留測試連線 + 模型列表）
// ─────────────────────────────────────────────
function buildOllamaSection(
  config: AppConfig,
  onChange: (c: AppConfig) => void
): HTMLElement {
  const wrapper = buildProviderSection([]);

  // Endpoint 輸入 + 測試按鈕
  const endpointGroup = document.createElement('div');
  endpointGroup.className = 'form-group';
  const endpointLabel = document.createElement('label');
  endpointLabel.textContent = 'Ollama Endpoint';
  const endpointRow = document.createElement('div');
  endpointRow.className = 'input-row';

  const endpointInput = document.createElement('input');
  endpointInput.type = 'text';
  endpointInput.className = 'form-control';
  endpointInput.value = config.ollamaEndpoint;
  endpointInput.placeholder = 'http://localhost:11434';
  endpointInput.addEventListener('input', () => {
    config = { ...config, ollamaEndpoint: endpointInput.value };
    onChange(config);
  });

  const testBtn = document.createElement('button');
  testBtn.className = 'btn btn-secondary btn-sm';
  testBtn.textContent = '測試連線';
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = '測試中...';
    try {
      const ok = await testOllamaConnection(endpointInput.value);
      if (ok) {
        showToast('Ollama 連線成功', 'success');
        await loadOllamaModels();
      } else {
        showToast('Ollama 連線失敗', 'error');
      }
    } catch (err) {
      showToast(`連線錯誤：${String(err)}`, 'error');
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '測試連線';
    }
  });

  endpointRow.appendChild(endpointInput);
  endpointRow.appendChild(testBtn);
  endpointGroup.appendChild(endpointLabel);
  endpointGroup.appendChild(endpointRow);
  wrapper.appendChild(endpointGroup);

  // 模型列表
  const modelGroup = document.createElement('div');
  modelGroup.className = 'form-group';
  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'LLM 模型';
  const modelSelect = document.createElement('select');
  modelSelect.className = 'form-control';

  if (config.ollamaModel) {
    const opt = document.createElement('option');
    opt.value = config.ollamaModel;
    opt.textContent = config.ollamaModel;
    opt.selected = true;
    modelSelect.appendChild(opt);
  }
  modelSelect.addEventListener('change', () => {
    config = { ...config, ollamaModel: modelSelect.value };
    onChange(config);
  });

  modelGroup.appendChild(modelLabel);
  modelGroup.appendChild(modelSelect);
  wrapper.appendChild(modelGroup);

  const loadOllamaModels = async (): Promise<void> => {
    try {
      const models = await getOllamaModels(endpointInput.value);
      modelSelect.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        opt.selected = m === config.ollamaModel;
        modelSelect.appendChild(opt);
      }
      if (models.length > 0) {
        config = { ...config, ollamaModel: modelSelect.value };
        onChange(config);
      }
    } catch {
      showToast('無法取得 Ollama 模型列表', 'error');
    }
  };

  return wrapper;
}

// ─────────────────────────────────────────────
// 工具函式
// ─────────────────────────────────────────────
function buildProviderSection(children: HTMLElement[]): HTMLElement {
  const div = document.createElement('div');
  div.className = 'provider-config';
  for (const child of children) div.appendChild(child);
  return div;
}

function buildInputGroup(
  labelText: string,
  type: string,
  defaultValue: string,
  onChange: (v: string) => void
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'form-group';
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.className = 'form-control';
  input.value = defaultValue;
  input.addEventListener('input', () => onChange(input.value));
  group.appendChild(label);
  group.appendChild(input);
  return group;
}

function buildSelectGroup(
  labelText: string,
  options: Array<{ value: string; label: string }>,
  selected: string,
  onChange: (v: string) => void
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'form-group';
  const label = document.createElement('label');
  label.textContent = labelText;
  const select = document.createElement('select');
  select.className = 'form-control';
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    el.selected = opt.value === selected;
    select.appendChild(el);
  }
  select.addEventListener('change', () => onChange(select.value));
  group.appendChild(label);
  group.appendChild(select);
  return group;
}
