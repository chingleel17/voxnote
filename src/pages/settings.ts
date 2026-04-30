import type { AppConfig } from '../types';
import {
  getSettings, saveSettings,
  testLlmConnection, testOllamaConnection, getOllamaModels,
  detectLocalAsrTools,
  type LocalAsrInfo,
} from '../api/settings';
import { showToast } from '../components/toast';

// ─────────────────────────────────────────────
// 預設模型選項（來源：各供應商官方文件，2026-04-29）
// ─────────────────────────────────────────────
const OPENAI_MODELS = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'o4-mini',
];
const CLAUDE_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-6',
  'claude-sonnet-4-5',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
];
const GEMINI_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
];
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
  const asrSection = buildAsrSection(config, (updated) => {
    // 只合併 ASR 相關欄位，避免覆蓋 LLM section 的變更
    config = {
      ...config,
      asr_provider: updated.asr_provider,
      assembly_ai_key: updated.assembly_ai_key,
      local_asr_model: updated.local_asr_model,
    };
  });
  form.appendChild(asrSection);

  // ── LLM 區塊 ──
  const llmSection = buildLlmSection(config, (updated) => {
    // 只合併 LLM 相關欄位，避免覆蓋 ASR section 的變更
    config = {
      ...config,
      llm_provider: updated.llm_provider,
      openai_key: updated.openai_key,
      openai_model: updated.openai_model,
      claude_key: updated.claude_key,
      claude_model: updated.claude_model,
      gemini_key: updated.gemini_key,
      gemini_model: updated.gemini_model,
      openrouter_key: updated.openrouter_key,
      openrouter_model: updated.openrouter_model,
      ollama_endpoint: updated.ollama_endpoint,
      ollama_model: updated.ollama_model,
      custom_endpoint: updated.custom_endpoint,
      custom_api_key: updated.custom_api_key,
      custom_model: updated.custom_model,
    };
  });
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
    config.asr_provider,
    (v) => {
      config = { ...config, asr_provider: v as AppConfig['asr_provider'] };
      onChange(config);
      updateAsrVisibility(v);
    }
  );
  section.appendChild(providerGroup);

  // AssemblyAI Key
  const assemblySection = document.createElement('div');
  assemblySection.appendChild(
    buildInputGroup('AssemblyAI API Key', 'password', config.assembly_ai_key, (v) => {
      config = { ...config, assembly_ai_key: v };
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
      config.local_asr_model,
      (v) => {
        config = { ...config, local_asr_model: v as AppConfig['local_asr_model'] };
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
  updateAsrVisibility(config.asr_provider);

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
    config.llm_provider,
    (v) => {
      config = { ...config, llm_provider: v as AppConfig['llm_provider'] };
      onChange(config);
      updateLlmVisibility(v);
    }
  );
  section.appendChild(providerGroup);

  // ── OpenAI ──
  const openaiSection = buildProviderSection([
    buildInputGroup('OpenAI API Key', 'password', config.openai_key, (v) => {
      config = { ...config, openai_key: v }; onChange(config);
    }),
    buildSelectGroup('模型', OPENAI_MODELS.map((m) => ({ value: m, label: m })), config.openai_model, (v) => {
      config = { ...config, openai_model: v }; onChange(config);
    }),
  ]);
  section.appendChild(openaiSection);

  // ── Claude ──
  const claudeSection = buildProviderSection([
    buildInputGroup('Claude API Key', 'password', config.claude_key, (v) => {
      config = { ...config, claude_key: v }; onChange(config);
    }),
    buildSelectGroup('模型', CLAUDE_MODELS.map((m) => ({ value: m, label: m })), config.claude_model, (v) => {
      config = { ...config, claude_model: v }; onChange(config);
    }),
  ]);
  section.appendChild(claudeSection);

  // ── Gemini ──
  const geminiSection = buildProviderSection([
    buildInputGroup('Gemini API Key', 'password', config.gemini_key, (v) => {
      config = { ...config, gemini_key: v }; onChange(config);
    }),
    buildSelectGroup('模型', GEMINI_MODELS.map((m) => ({ value: m, label: m })), config.gemini_model, (v) => {
      config = { ...config, gemini_model: v }; onChange(config);
    }),
  ]);
  section.appendChild(geminiSection);

  // ── OpenRouter ──
  const openrouterSection = buildProviderSection([
    buildInputGroup('OpenRouter API Key', 'password', config.openrouter_key, (v) => {
      config = { ...config, openrouter_key: v }; onChange(config);
    }),
    buildInputGroup('模型（例如：openai/gpt-4o-mini）', 'text', config.openrouter_model, (v) => {
      config = { ...config, openrouter_model: v }; onChange(config);
    }),
  ]);
  section.appendChild(openrouterSection);

  // ── Ollama ──
  const ollamaSection = buildOllamaSection(config, (updated) => {
    // 只合併 ollama 專屬欄位，避免覆蓋 llm_provider 等其他 LLM 欄位
    config = { ...config, ollama_endpoint: updated.ollama_endpoint, ollama_model: updated.ollama_model };
    onChange(config);
  });
  section.appendChild(ollamaSection);

  // ── 自訂端點 ──
  const customSection = buildProviderSection([
    buildInputGroup('API Endpoint（OpenAI-compatible）', 'text', config.custom_endpoint, (v) => {
      config = { ...config, custom_endpoint: v }; onChange(config);
    }),
    buildInputGroup('API Key（可留空）', 'password', config.custom_api_key, (v) => {
      config = { ...config, custom_api_key: v }; onChange(config);
    }),
    buildInputGroup('模型名稱', 'text', config.custom_model, (v) => {
      config = { ...config, custom_model: v }; onChange(config);
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
      // 先儲存當前設定，再從磁碟讀取進行測試
      await saveSettings(config);
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
  updateLlmVisibility(config.llm_provider);

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
  endpointInput.value = config.ollama_endpoint;
  endpointInput.placeholder = 'http://localhost:11434';
  endpointInput.addEventListener('input', () => {
    config = { ...config, ollama_endpoint: endpointInput.value };
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

  if (config.ollama_model) {
    const opt = document.createElement('option');
    opt.value = config.ollama_model;
    opt.textContent = config.ollama_model;
    opt.selected = true;
    modelSelect.appendChild(opt);
  }
  modelSelect.addEventListener('change', () => {
    config = { ...config, ollama_model: modelSelect.value };
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
        opt.selected = m === config.ollama_model;
        modelSelect.appendChild(opt);
      }
      if (models.length > 0) {
        config = { ...config, ollama_model: modelSelect.value };
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
