import type { AppConfig } from '../types';
import {
  saveSettings,
  testLlmConnection, testOllamaConnection, getOllamaModels,
  detectLocalAsrTools, testLocalAsrConnection,
  type LocalAsrInfo,
} from '../api/settings';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { exportFullBackup, importFullBackup, preflightFullBackup } from '../api/backup';
import { showToast } from '../components/toast';
import { initConfigStore, setCurrentConfig } from '../utils/configStore';
import { sendTestNotification } from '../utils/notifications';

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
const ASSEMBLYAI_SPEECH_MODELS: Array<{
  value: AppConfig['assembly_ai_speech_model'];
  label: string;
}> = [
    { value: 'universal-2', label: 'Universal-2' },
    { value: 'universal-3-pro', label: 'Universal-3 Pro' },
  ];
const LOCAL_ASR_MODELS = ['tiny', 'base', 'small', 'medium', 'large'];
const OLLAMA_THINK_LEVELS: Array<{ value: AppConfig['ollama_think_level']; label: string }> = [
  { value: 'off', label: '關閉思考' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

// ─────────────────────────────────────────────
// 主要渲染函式
// ─────────────────────────────────────────────
export async function renderSettingsPage(container: HTMLElement): Promise<void> {
  container.innerHTML = '<div class="loading">載入設定中...</div>';

  let config: AppConfig;
  let autoSaveTimer: ReturnType<typeof window.setTimeout> | null = null;
  let latestSaveRequest = 0;
  let latestSavedRequest = 0;
  try {
    config = await initConfigStore();
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

  const settingsGrid = document.createElement('div');
  settingsGrid.className = 'settings-grid';
  form.appendChild(settingsGrid);

  const saveStatus = document.createElement('small');
  saveStatus.className = 'form-hint';
  saveStatus.hidden = true;

  const setSaveStatus = (message: string, isError = false): void => {
    saveStatus.hidden = false;
    saveStatus.textContent = message;
    saveStatus.style.color = isError ? 'var(--danger-color, #d93025)' : '';
  };

  const clearSaveStatus = (): void => {
    saveStatus.hidden = true;
    saveStatus.textContent = '';
    saveStatus.style.color = '';
  };

  const persistSettings = async (mode: 'auto' | 'manual'): Promise<void> => {
    const requestId = ++latestSaveRequest;
    const snapshot = { ...config };
    setSaveStatus(mode === 'auto' ? '正在自動儲存設定…' : '正在儲存設定…');

    try {
      await saveSettings(snapshot);
      if (requestId < latestSavedRequest) {
        return;
      }

      latestSavedRequest = requestId;
      clearSaveStatus();
      if (mode === 'manual') {
        showToast('設定已儲存', 'success');
      }
    } catch (err) {
      const message = String(err);
      setSaveStatus(mode === 'auto' ? '自動儲存失敗，請手動儲存。' : '儲存失敗，請再試一次。', true);
      showToast(mode === 'auto' ? `自動儲存失敗：${message}` : `儲存失敗：${message}`, 'error');
    }
  };

  const scheduleAutoSave = (): void => {
    if (autoSaveTimer) {
      window.clearTimeout(autoSaveTimer);
    }

    setSaveStatus('變更已暫存，稍後自動儲存…');
    autoSaveTimer = window.setTimeout(() => {
      autoSaveTimer = null;
      void persistSettings('auto');
    }, 500);
  };

  // ── ASR 區塊 ──
  const asrSection = buildAsrSection(config, (updated) => {
    // 只合併 ASR 相關欄位，避免覆蓋 LLM section 的變更
    config = {
      ...config,
      asr_provider: updated.asr_provider,
      assembly_ai_key: updated.assembly_ai_key,
      assembly_ai_speech_model: updated.assembly_ai_speech_model,
      local_asr_model: updated.local_asr_model,
      local_asr_base_url: updated.local_asr_base_url,
      asr_language: updated.asr_language,
      speaker_detection: updated.speaker_detection,
      auto_proofread_after_transcription: updated.auto_proofread_after_transcription,
    };
    setCurrentConfig(config);
    scheduleAutoSave();
  });
  settingsGrid.appendChild(asrSection);

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
      ollama_think_level: updated.ollama_think_level,
      custom_endpoint: updated.custom_endpoint,
      custom_api_key: updated.custom_api_key,
      custom_model: updated.custom_model,
    };
    setCurrentConfig(config);
    scheduleAutoSave();
  });
  settingsGrid.appendChild(llmSection);

  const notificationSection = buildNotificationSection(config, (updated) => {
    config = {
      ...config,
      completion_notification_enabled: updated.completion_notification_enabled,
    };
    setCurrentConfig(config);
    scheduleAutoSave();
  });
  settingsGrid.appendChild(notificationSection);

  // ── AI Prompt 自訂區塊 ──
  const promptSection = buildAiPromptSection(config, (updated) => {
    config = {
      ...config,
      proofread_prompt: updated.proofread_prompt,
      summary_prompt: updated.summary_prompt,
    };
    setCurrentConfig(config);
    scheduleAutoSave();
  });

  const storageSection = buildStorageSection(config, (updated) => {
    config = {
      ...config,
      recording_storage_dir: updated.recording_storage_dir,
      archive_storage_dir: updated.archive_storage_dir,
    };
    setCurrentConfig(config);
    scheduleAutoSave();
  });

  const backupSection = buildBackupSection();
  const advancedSection = buildAdvancedSection([promptSection, storageSection, backupSection]);
  form.appendChild(advancedSection);

  // ── 儲存按鈕 ──
  const saveRow = document.createElement('div');
  saveRow.className = 'settings-save-row';
  const saveMeta = document.createElement('div');
  saveMeta.className = 'settings-save-meta';
  saveMeta.appendChild(saveStatus);
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = '儲存設定';
  saveBtn.addEventListener('click', async () => {
    if (autoSaveTimer) {
      window.clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    await persistSettings('manual');
  });
  saveRow.appendChild(saveMeta);
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
        { value: 'voxnote_asr', label: 'VoxNote 轉錄服務' },
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
  assemblySection.appendChild(
    buildSelectGroup(
      'AssemblyAI 模型',
      ASSEMBLYAI_SPEECH_MODELS,
      config.assembly_ai_speech_model || 'universal-2',
      (v) => {
        config = { ...config, assembly_ai_speech_model: v as AppConfig['assembly_ai_speech_model'] };
        onChange(config);
      }
    )
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

  // 本地 ASR 伺服器
  const localServerSection = buildProviderSection([]);
  const endpointGroup = document.createElement('div');
  endpointGroup.className = 'form-group';
  const endpointLabel = document.createElement('label');
  endpointLabel.textContent = 'Base URL';
  const endpointRow = document.createElement('div');
  endpointRow.className = 'input-row';
  const endpointInput = document.createElement('input');
  endpointInput.type = 'url';
  endpointInput.className = 'form-control';
  endpointInput.value = config.local_asr_base_url;
  endpointInput.placeholder = 'http://localhost:8000';
  endpointInput.addEventListener('input', () => {
    config = { ...config, local_asr_base_url: endpointInput.value };
    onChange(config);
  });
  const testServerBtn = document.createElement('button');
  testServerBtn.type = 'button';
  testServerBtn.className = 'btn btn-secondary btn-sm';
  testServerBtn.textContent = '測試連線';
  testServerBtn.addEventListener('click', async () => {
    testServerBtn.disabled = true;
    testServerBtn.textContent = '測試中...';
    try {
      const reachable = await testLocalAsrConnection(endpointInput.value);
      showToast(reachable ? '本地 ASR 伺服器連線成功' : '本地 ASR 伺服器未通過健康檢查', reachable ? 'success' : 'error');
    } catch (err) {
      showToast(`本地 ASR 伺服器連線失敗：${String(err)}`, 'error');
    } finally {
      testServerBtn.disabled = false;
      testServerBtn.textContent = '測試連線';
    }
  });
  endpointRow.append(endpointInput, testServerBtn);
  endpointGroup.append(endpointLabel, endpointRow);
  localServerSection.appendChild(endpointGroup);

  section.appendChild(localServerSection);

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

  // 語言設定（共用）
  section.appendChild(
    buildSelectGroup(
      '轉錄語言',
      [
        { value: 'zh', label: '中文（繁體/簡體）' },
        { value: 'en', label: '英文' },
        { value: 'ja', label: '日文' },
        { value: 'ko', label: '韓文' },
        { value: 'auto', label: '自動偵測' },
      ],
      config.asr_language || 'zh',
      (v) => {
        config = { ...config, asr_language: v };
        onChange(config);
      }
    )
  );

  // 語者分離（AssemblyAI 與本地伺服器支援）
  const speakerGroup = document.createElement('div');
  speakerGroup.className = 'form-group';
  const speakerLabel = document.createElement('label');
  speakerLabel.textContent = '語者分離';
  const speakerToggle = document.createElement('label');
  speakerToggle.className = 'toggle-switch';
  const speakerInput = document.createElement('input');
  speakerInput.type = 'checkbox';
  speakerInput.checked = config.speaker_detection !== false;
  speakerInput.addEventListener('change', () => {
    config = { ...config, speaker_detection: speakerInput.checked };
    onChange(config);
  });
  const speakerSlider = document.createElement('span');
  speakerSlider.className = 'toggle-slider';
  speakerToggle.appendChild(speakerInput);
  speakerToggle.appendChild(speakerSlider);
  const speakerHint = document.createElement('small');
  speakerHint.className = 'form-hint';
  speakerHint.textContent = 'AssemblyAI 與本地伺服器啟用後，逐字稿將包含時間軸與講者標籤；預期人數會自動取自會議的與會人員。';
  speakerGroup.appendChild(speakerLabel);
  speakerGroup.appendChild(speakerToggle);
  speakerGroup.appendChild(speakerHint);
  section.appendChild(speakerGroup);

  const autoProofreadGroup = document.createElement('div');
  autoProofreadGroup.className = 'form-group';
  const autoProofreadLabel = document.createElement('label');
  autoProofreadLabel.textContent = '逐段轉譯後自動 AI 校稿';
  const autoProofreadToggle = document.createElement('label');
  autoProofreadToggle.className = 'toggle-switch';
  const autoProofreadInput = document.createElement('input');
  autoProofreadInput.type = 'checkbox';
  autoProofreadInput.checked = config.auto_proofread_after_transcription === true;
  autoProofreadInput.addEventListener('change', () => {
    config = { ...config, auto_proofread_after_transcription: autoProofreadInput.checked };
    onChange(config);
  });
  const autoProofreadSlider = document.createElement('span');
  autoProofreadSlider.className = 'toggle-slider';
  autoProofreadToggle.appendChild(autoProofreadInput);
  autoProofreadToggle.appendChild(autoProofreadSlider);
  const autoProofreadHint = document.createElement('small');
  autoProofreadHint.className = 'form-hint';
  autoProofreadHint.textContent = '啟用後，每段錄音完成轉譯時會立即校稿該段，並同步更新整份校稿版逐字稿。';
  autoProofreadGroup.appendChild(autoProofreadLabel);
  autoProofreadGroup.appendChild(autoProofreadToggle);
  autoProofreadGroup.appendChild(autoProofreadHint);
  section.appendChild(autoProofreadGroup);

  // 可見性控制
  const updateAsrVisibility = (provider: string): void => {
    assemblySection.style.display = provider === 'assemblyai' ? '' : 'none';
    localSection.style.display = provider === 'local' ? '' : 'none';
    localServerSection.style.display = provider === 'voxnote_asr' ? '' : 'none';
  };
  updateAsrVisibility(config.asr_provider);

  return section;
}

// ─────────────────────────────────────────────
// 錄音儲存區塊
// ─────────────────────────────────────────────
function buildStorageSection(
  config: AppConfig,
  onChange: (c: AppConfig) => void
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'settings-section';

  const heading = document.createElement('h3');
  heading.className = 'settings-section-title';
  heading.textContent = '錄音與封存';
  section.appendChild(heading);

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.style.marginBottom = '16px';
  hint.textContent = '可指定新錄音的儲存資料夾與整個會議封存資料夾。留空時會使用預設 AppData 路徑（recordings / archives）。';
  section.appendChild(hint);

  section.appendChild(buildDirectoryPickerGroup(
    '錄音儲存資料夾',
    config.recording_storage_dir,
    async (value) => {
      config = { ...config, recording_storage_dir: value };
      onChange(config);
    }
  ));

  section.appendChild(buildDirectoryPickerGroup(
    '封存資料夾',
    config.archive_storage_dir,
    async (value) => {
      config = { ...config, archive_storage_dir: value };
      onChange(config);
    }
  ));

  return section;
}

function buildBackupSection(): HTMLElement {
  const section = document.createElement('section');
  section.className = 'settings-section';

  const heading = document.createElement('h3');
  heading.className = 'settings-section-title';
  heading.textContent = '資料備份與還原';
  section.appendChild(heading);

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.textContent = '備份包含會議、逐字稿、摘要、範本、錄音與封存檔案，不包含 API 金鑰與設定。';
  section.appendChild(hint);

  const actions = document.createElement('div');
  actions.className = 'section-actions';
  const exportButton = document.createElement('button');
  exportButton.type = 'button';
  exportButton.className = 'btn btn-secondary btn-sm';
  exportButton.textContent = '建立完整備份';
  const importButton = document.createElement('button');
  importButton.type = 'button';
  importButton.className = 'btn btn-secondary btn-sm';
  importButton.textContent = '從備份還原';
  actions.append(exportButton, importButton);
  section.appendChild(actions);

  const setBusy = (busy: boolean): void => {
    exportButton.disabled = busy;
    importButton.disabled = busy;
  };

  exportButton.addEventListener('click', async () => {
    const destination = await saveDialog({
      defaultPath: `voxnote-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'VoxNote 備份', extensions: ['zip'] }],
    });
    if (!destination) return;

    setBusy(true);
    try {
      const result = await exportFullBackup(destination);
      const warning = result.warnings.length ? `，${result.warnings.length} 個警告` : '';
      showToast(`備份完成：已收錄 ${result.added} 個檔案${warning}`, result.warnings.length ? 'warning' : 'success', 5000);
    } catch (err) {
      showToast(`建立備份失敗：${String(err)}`, 'error', 5000);
    } finally {
      setBusy(false);
    }
  });

  importButton.addEventListener('click', async () => {
    const selected = await openDialog({
      multiple: false,
      filters: [{ name: 'VoxNote 備份', extensions: ['zip'] }],
    });
    if (!selected || Array.isArray(selected)) return;

    setBusy(true);
    try {
      const preflight = await preflightFullBackup(selected);
      const { meetings, recordings, assets } = preflight.summary;
      const summary = `備份建立於 ${new Date(preflight.summary.createdAt).toLocaleString()}，包含 ${meetings} 場會議、${recordings} 段錄音與 ${assets} 個檔案。`;
      const overwrite = window.confirm(`${summary}\n\n按「確定」覆蓋目前所有 VoxNote 資料；按「取消」改用合併匯入。`);
      const mode = overwrite ? 'overwrite' : 'merge';
      const modeLabel = overwrite ? '覆蓋' : '合併';
      if (!window.confirm(`確定要以「${modeLabel}」模式還原嗎？此操作期間無法修改會議資料。`)) return;

      const result = await importFullBackup(selected, mode);
      const warning = result.warnings.length ? `，${result.warnings.length} 個警告` : '';
      showToast(`還原完成：新增 ${result.added}、略過 ${result.skipped}、重用 ${result.reused}${warning}`, result.warnings.length ? 'warning' : 'success', 7000);
      window.location.reload();
    } catch (err) {
      showToast(`還原失敗：${String(err)}`, 'error', 6000);
    } finally {
      setBusy(false);
    }
  });

  return section;
}

function buildNotificationSection(
  config: AppConfig,
  onChange: (c: AppConfig) => void,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'settings-section';

  const heading = document.createElement('h3');
  heading.className = 'settings-section-title';
  heading.textContent = '完成通知';
  section.appendChild(heading);

  const notifyGroup = document.createElement('div');
  notifyGroup.className = 'form-group';
  const notifyLabel = document.createElement('label');
  notifyLabel.textContent = 'Windows 原生完成通知';
  const notifyToggle = document.createElement('label');
  notifyToggle.className = 'toggle-switch';
  const notifyInput = document.createElement('input');
  notifyInput.type = 'checkbox';
  notifyInput.checked = config.completion_notification_enabled !== false;
  notifyInput.addEventListener('change', () => {
    config = {
      ...config,
      completion_notification_enabled: notifyInput.checked,
    };
    onChange(config);
  });
  const notifySlider = document.createElement('span');
  notifySlider.className = 'toggle-slider';
  notifyToggle.appendChild(notifyInput);
  notifyToggle.appendChild(notifySlider);
  const notifyHint = document.createElement('small');
  notifyHint.className = 'form-hint';
  notifyHint.textContent = '當逐段轉譯、AI 校稿或摘要生成完成時，若 VoxNote 不在前景視窗，就顯示 Windows 通知。';
  notifyGroup.appendChild(notifyLabel);
  notifyGroup.appendChild(notifyToggle);
  notifyGroup.appendChild(notifyHint);
  section.appendChild(notifyGroup);

  const testRow = document.createElement('div');
  testRow.className = 'section-actions';

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn btn-secondary btn-sm';
  testBtn.textContent = '發送測試通知';
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    try {
      const result = await sendTestNotification();
      if (!result.enabled) {
        showToast('測試通知未發送：完成通知目前已停用。', 'warning');
      } else if (!result.permissionGranted) {
        showToast('測試通知未發送：Windows 通知權限未允許。', 'warning', 5000);
      } else {
        showToast(
          result.focused
            ? '測試通知已送出。此按鈕會忽略前景限制，用來確認通知鏈路是否正常。'
            : '測試通知已送出。',
          'success',
          5000,
        );
      }
    } catch (err) {
      showToast(`測試通知失敗：${String(err)}`, 'error', 5000);
    } finally {
      testBtn.disabled = false;
    }
  });

  const testHint = document.createElement('small');
  testHint.className = 'form-hint';
  testHint.textContent = '此按鈕會直接送出一則測試通知，並忽略「前景視窗不通知」限制，方便排查是焦點判斷還是通知鏈路有問題。';

  testRow.appendChild(testBtn);
  section.appendChild(testRow);
  section.appendChild(testHint);

  return section;
}

// ─────────────────────────────────────────────
// 進階設定
// ─────────────────────────────────────────────
function buildAdvancedSection(children: HTMLElement[]): HTMLElement {
  const details = document.createElement('details');
  details.className = 'settings-advanced';

  const summary = document.createElement('summary');
  summary.className = 'settings-advanced-summary';
  summary.textContent = '進階設定';
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'settings-advanced-body';
  for (const child of children) {
    body.appendChild(child);
  }
  details.appendChild(body);

  return details;
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
    config = {
      ...config,
      ollama_endpoint: updated.ollama_endpoint,
      ollama_model: updated.ollama_model,
      ollama_think_level: updated.ollama_think_level,
    };
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
        testBtn.disabled = false;
        testBtn.textContent = '測試連線';
        void loadOllamaModels();
      } else {
        showToast('Ollama 連線失敗', 'error');
      }
    } catch (err) {
      showToast(`連線錯誤：${String(err)}`, 'error');
    } finally {
      if (testBtn.disabled) {
        testBtn.disabled = false;
        testBtn.textContent = '測試連線';
      }
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

  const thinkGroup = document.createElement('div');
  thinkGroup.className = 'form-group';
  const thinkLabel = document.createElement('label');
  thinkLabel.textContent = '思考強度';
  const thinkSelect = document.createElement('select');
  thinkSelect.className = 'form-control';
  for (const option of OLLAMA_THINK_LEVELS) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    el.selected = option.value === (config.ollama_think_level ?? 'low');
    thinkSelect.appendChild(el);
  }
  thinkSelect.addEventListener('change', () => {
    config = {
      ...config,
      ollama_think_level: thinkSelect.value as AppConfig['ollama_think_level'],
    };
    onChange(config);
  });
  const thinkHint = document.createElement('small');
  thinkHint.className = 'form-hint';
  thinkHint.textContent = '建議先用低，若請求過久可改成關閉思考。';
  thinkGroup.appendChild(thinkLabel);
  thinkGroup.appendChild(thinkSelect);
  thinkGroup.appendChild(thinkHint);
  wrapper.appendChild(thinkGroup);

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
    } catch (err) {
      showToast(`無法取得 Ollama 模型列表：${String(err)}`, 'error');
    }
  };

  return wrapper;
}

// ─────────────────────────────────────────────
// AI Prompt 自訂區塊
// ─────────────────────────────────────────────
function buildAiPromptSection(
  config: AppConfig,
  onChange: (c: AppConfig) => void
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'settings-section';

  const heading = document.createElement('h3');
  heading.className = 'settings-section-title';
  heading.textContent = 'AI Prompt 自訂';
  section.appendChild(heading);

  const hint = document.createElement('p');
  hint.className = 'form-hint';
  hint.style.marginBottom = '16px';
  hint.textContent = '留空代表使用內建預設 Prompt。變更後會自動儲存。';
  section.appendChild(hint);

  // 校稿 Prompt
  const proofreadGroup = document.createElement('div');
  proofreadGroup.className = 'form-group';
  const proofreadLabel = document.createElement('label');
  proofreadLabel.textContent = '校稿 Prompt（AI 校稿用）';
  const proofreadTextarea = document.createElement('textarea');
  proofreadTextarea.className = 'form-control';
  proofreadTextarea.rows = 6;
  proofreadTextarea.value = config.proofread_prompt ?? '';
  proofreadTextarea.placeholder = [
    '你是一位專業的中文會議記錄校對員。',
    '請校正以下逐字稿中的錯字（同音字、漏字、多字、標點錯誤）。',
    '保留所有時間標記 [MM:SS] 不得刪除或修改。',
    '保留所有講者標記（例如「講者A：」）不得刪除。',
    '必須輸出完整的全部逐字稿內容，嚴禁使用任何省略標記。',
    '只輸出修正後的完整逐字稿，不要加任何說明或前後文。',
  ].join('\n');
  proofreadTextarea.addEventListener('input', () => {
    config = { ...config, proofread_prompt: proofreadTextarea.value };
    onChange(config);
  });
  proofreadGroup.appendChild(proofreadLabel);
  proofreadGroup.appendChild(proofreadTextarea);
  section.appendChild(proofreadGroup);

  // 總結 Prompt
  const summaryGroup = document.createElement('div');
  summaryGroup.className = 'form-group';
  const summaryLabel = document.createElement('label');
  summaryLabel.textContent = '總結 Prompt（AI 生成會議總結用）';
  const summaryTextarea = document.createElement('textarea');
  summaryTextarea.className = 'form-control';
  summaryTextarea.rows = 8;
  summaryTextarea.value = config.summary_prompt ?? '';
  summaryTextarea.placeholder = [
    '你是一位專業的會議記錄助理。請根據以下逐字稿生成結構清晰的會議摘要。',
    '使用繁體中文，以 Markdown 格式輸出，包含以下章節（若無相關內容可省略該章節）：',
    '## 會議摘要',
    '## 參與人員',
    '## 主要議題',
    '## 決議事項',
    '## 待辦事項（TODO）',
    '## 重要時間點（含 [MM:SS] 時間標記）',
    '## 專有名詞說明',
  ].join('\n');
  summaryTextarea.addEventListener('input', () => {
    config = { ...config, summary_prompt: summaryTextarea.value };
    onChange(config);
  });
  summaryGroup.appendChild(summaryLabel);
  summaryGroup.appendChild(summaryTextarea);
  section.appendChild(summaryGroup);

  return section;
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

function buildDirectoryPickerGroup(
  labelText: string,
  value: string,
  onChange: (v: string) => void | Promise<void>
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'form-group';

  const label = document.createElement('label');
  label.textContent = labelText;

  const row = document.createElement('div');
  row.className = 'directory-picker-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-control';
  input.readOnly = true;
  input.value = value;
  input.placeholder = '未指定，將使用預設路徑';

  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'btn btn-secondary btn-sm';
  pickBtn.textContent = '選擇資料夾';
  pickBtn.addEventListener('click', async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: labelText,
    });
    if (typeof selected === 'string') {
      input.value = selected;
      await onChange(selected);
    }
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-ghost btn-sm';
  clearBtn.textContent = '清除';
  clearBtn.addEventListener('click', async () => {
    input.value = '';
    await onChange('');
  });

  row.appendChild(input);
  row.appendChild(pickBtn);
  row.appendChild(clearBtn);
  group.appendChild(label);
  group.appendChild(row);
  return group;
}
