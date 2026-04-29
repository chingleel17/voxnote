import type { AppConfig } from '../types';
import { getSettings, saveSettings, testOllamaConnection, getOllamaModels } from '../api/settings';
import { showToast } from '../components/toast';

const GEMINI_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];

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

  // ---- Provider 模式選擇 ----
  const providerSection = document.createElement('section');
  providerSection.className = 'settings-section';
  const providerHeading = document.createElement('h3');
  providerHeading.className = 'settings-section-title';
  providerHeading.textContent = 'Provider 模式';
  providerSection.appendChild(providerHeading);

  const modes: Array<{ value: AppConfig['providerMode']; label: string; desc: string }> = [
    { value: 'cloud', label: 'Cloud', desc: '使用 AssemblyAI + Gemini 雲端服務' },
    { value: 'hybrid', label: 'Hybrid', desc: '語音轉錄用 AssemblyAI，摘要用本地 Ollama' },
    { value: 'ollama', label: 'Ollama', desc: '完全本地端，使用 Ollama 執行所有任務' },
  ];

  for (const mode of modes) {
    const radioLabel = document.createElement('label');
    radioLabel.className = 'radio-label';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'providerMode';
    radio.value = mode.value;
    radio.checked = config.providerMode === mode.value;
    radio.addEventListener('change', () => {
      if (radio.checked) {
        config = { ...config, providerMode: mode.value };
        updateVisibility();
      }
    });

    const textDiv = document.createElement('div');
    const nameSpan = document.createElement('strong');
    nameSpan.textContent = mode.label;
    const descSpan = document.createElement('span');
    descSpan.className = 'radio-desc';
    descSpan.textContent = ` — ${mode.desc}`;
    textDiv.appendChild(nameSpan);
    textDiv.appendChild(descSpan);

    radioLabel.appendChild(radio);
    radioLabel.appendChild(textDiv);
    providerSection.appendChild(radioLabel);
  }

  form.appendChild(providerSection);

  // ---- Cloud 設定區（AssemblyAI + Gemini）----
  const cloudSection = document.createElement('section');
  cloudSection.className = 'settings-section';
  const cloudHeading = document.createElement('h3');
  cloudHeading.className = 'settings-section-title';
  cloudHeading.textContent = 'Cloud / Hybrid 設定';
  cloudSection.appendChild(cloudHeading);

  const assemblyGroup = buildInputGroup('AssemblyAI API Key', 'password', config.assemblyAiKey, (v) => {
    config = { ...config, assemblyAiKey: v };
  });
  cloudSection.appendChild(assemblyGroup);

  const geminiGroup = buildInputGroup('Gemini API Key', 'password', config.geminiKey, (v) => {
    config = { ...config, geminiKey: v };
  });
  cloudSection.appendChild(geminiGroup);

  // Gemini 模型選擇
  const geminiModelGroup = document.createElement('div');
  geminiModelGroup.className = 'form-group';
  const geminiModelLabel = document.createElement('label');
  geminiModelLabel.textContent = 'Gemini 模型';
  const geminiModelSelect = document.createElement('select');
  geminiModelSelect.className = 'form-control';
  for (const model of GEMINI_MODELS) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    opt.selected = config.geminiModel === model;
    geminiModelSelect.appendChild(opt);
  }
  geminiModelSelect.addEventListener('change', () => {
    config = { ...config, geminiModel: geminiModelSelect.value };
  });
  geminiModelGroup.appendChild(geminiModelLabel);
  geminiModelGroup.appendChild(geminiModelSelect);
  cloudSection.appendChild(geminiModelGroup);

  form.appendChild(cloudSection);

  // ---- Ollama 設定區 ----
  const ollamaSection = document.createElement('section');
  ollamaSection.className = 'settings-section';
  const ollamaHeading = document.createElement('h3');
  ollamaHeading.className = 'settings-section-title';
  ollamaHeading.textContent = 'Ollama 設定';
  ollamaSection.appendChild(ollamaHeading);

  // Endpoint 輸入
  const endpointGroup = document.createElement('div');
  endpointGroup.className = 'form-group';
  const endpointLabel = document.createElement('label');
  endpointLabel.textContent = 'Ollama Endpoint';
  const endpointInput = document.createElement('input');
  endpointInput.type = 'text';
  endpointInput.className = 'form-control';
  endpointInput.value = config.ollamaEndpoint;
  endpointInput.placeholder = 'http://localhost:11434';
  endpointInput.addEventListener('input', () => {
    config = { ...config, ollamaEndpoint: endpointInput.value };
  });
  endpointGroup.appendChild(endpointLabel);

  const endpointRow = document.createElement('div');
  endpointRow.className = 'input-row';
  endpointRow.appendChild(endpointInput);

  const testBtn = document.createElement('button');
  testBtn.className = 'btn btn-secondary btn-sm';
  testBtn.textContent = '測試連線';
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = '測試中...';
    try {
      const ok = await testOllamaConnection(endpointInput.value);
      if (ok) {
        showToast('連線成功', 'success');
        await loadOllamaModels();
      } else {
        showToast('連線失敗', 'error');
      }
    } catch (err) {
      showToast(`連線錯誤：${String(err)}`, 'error');
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = '測試連線';
    }
  });
  endpointRow.appendChild(testBtn);
  endpointGroup.appendChild(endpointRow);
  ollamaSection.appendChild(endpointGroup);

  // LLM 模型選擇
  const llmModelGroup = document.createElement('div');
  llmModelGroup.className = 'form-group';
  const llmModelLabel = document.createElement('label');
  llmModelLabel.textContent = 'LLM 模型';
  const llmModelSelect = document.createElement('select');
  llmModelSelect.className = 'form-control';

  // 預填現有模型
  if (config.ollamaLlmModel) {
    const opt = document.createElement('option');
    opt.value = config.ollamaLlmModel;
    opt.textContent = config.ollamaLlmModel;
    opt.selected = true;
    llmModelSelect.appendChild(opt);
  }

  llmModelSelect.addEventListener('change', () => {
    config = { ...config, ollamaLlmModel: llmModelSelect.value };
  });

  llmModelGroup.appendChild(llmModelLabel);
  llmModelGroup.appendChild(llmModelSelect);
  ollamaSection.appendChild(llmModelGroup);

  form.appendChild(ollamaSection);

  // ---- 儲存按鈕 ----
  const saveGroup = document.createElement('div');
  saveGroup.className = 'settings-save-row';
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
  saveGroup.appendChild(saveBtn);
  form.appendChild(saveGroup);

  // ---- 根據 providerMode 顯示/隱藏 ----
  function updateVisibility(): void {
    const mode = config.providerMode;
    cloudSection.style.display = mode === 'ollama' ? 'none' : '';
    ollamaSection.style.display = mode === 'cloud' ? 'none' : '';
  }

  async function loadOllamaModels(): Promise<void> {
    try {
      const models = await getOllamaModels(endpointInput.value);
      llmModelSelect.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        opt.selected = m === config.ollamaLlmModel;
        llmModelSelect.appendChild(opt);
      }
      if (models.length > 0) {
        config = { ...config, ollamaLlmModel: llmModelSelect.value };
      }
    } catch {
      showToast('無法取得 Ollama 模型列表', 'error');
    }
  }

  updateVisibility();
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
