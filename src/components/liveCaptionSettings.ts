import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getLiveCaptionBuildInfo } from '../api/liveCaption';
import type { AppConfig } from '../types';

/** 字幕字級的四檔預設值（像素），須與 src-tauri 的 FONT_SIZE_PRESETS 一致。 */
const FONT_SIZE_PRESETS = [20, 24, 28, 36];

/** 將既有 config.toml 內非四檔之一的數值收斂至最接近的預設檔位，供選單預選使用。 */
function nearestFontSizePreset(value: number): number {
  return FONT_SIZE_PRESETS.reduce((closest, preset) =>
    Math.abs(preset - value) < Math.abs(closest - value) ? preset : closest,
  );
}

/**
 * 視窗長度／步進的情境預設組合。數值取自 jt-live-whisper 的 SCENE_PRESETS
 * （見 add-live-caption-remote-asr/design.md 的查證記錄），與本專案現行的
 * 5 秒／3 秒同構，故「線上會議」維持原預設值不變。
 */
const WINDOW_SCENE_PRESETS: Array<{ value: string; label: string; windowSeconds: number; stepSeconds: number }> = [
  { value: 'meeting', label: '線上會議', windowSeconds: 5, stepSeconds: 3 },
  { value: 'training', label: '教育訓練', windowSeconds: 8, stepSeconds: 3 },
  { value: 'presentation', label: '演講簡報', windowSeconds: 12, stepSeconds: 4 },
  { value: 'fast', label: '快速字幕', windowSeconds: 3, stepSeconds: 2 },
];
const CUSTOM_WINDOW_SCENE = 'custom';

/** 依目前的視窗長度／步進找出對應的情境代碼；找不到完全匹配則回傳「自訂」。 */
function matchWindowScene(windowSeconds: number, stepSeconds: number): string {
  const matched = WINDOW_SCENE_PRESETS.find(
    (preset) => preset.windowSeconds === windowSeconds && preset.stepSeconds === stepSeconds,
  );
  return matched?.value ?? CUSTOM_WINDOW_SCENE;
}

/**
 * 即時字幕設定表單。
 *
 * 這些參數屬於「每次使用時會調整」的操作項目，故由即時字幕頁直接提供，
 * 不再放在設定頁；設定頁僅保留與錄音、轉譯、LLM 等長期組態相關的項目。
 */
export function buildLiveCaptionSettings(
  initialConfig: AppConfig,
  onChange: (config: AppConfig) => void,
): HTMLElement {
  let config = initialConfig;
  const container = document.createElement('div');
  container.className = 'live-caption-settings';

  const selectGroup = (
    labelText: string,
    options: Array<{ value: string; label: string }>,
    selected: string,
    update: (value: string) => void,
  ): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = labelText;
    const select = document.createElement('select');
    select.className = 'form-control';
    for (const option of options) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      element.selected = option.value === selected;
      select.appendChild(element);
    }
    select.addEventListener('change', () => update(select.value));
    group.append(label, select);
    return group;
  };

  const numberGroup = (
    labelText: string,
    value: number,
    min: number,
    max: number,
    step: number,
    update: (value: number) => void,
    hintText?: string,
  ): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'form-control';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (Number.isFinite(next)) update(next);
    });
    group.append(label, input);
    if (hintText) {
      const hint = document.createElement('small');
      hint.className = 'form-hint';
      hint.textContent = hintText;
      group.appendChild(hint);
    }
    return group;
  };

  const toggleGroup = (
    labelText: string,
    checked: boolean,
    update: (checked: boolean) => void,
    hintText?: string,
  ): HTMLElement => {
    const group = document.createElement('div');
    group.className = 'form-group';
    const label = document.createElement('label');
    label.textContent = labelText;
    const toggle = document.createElement('label');
    toggle.className = 'toggle-switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    const slider = document.createElement('span');
    slider.className = 'toggle-slider';
    input.addEventListener('change', () => update(input.checked));
    toggle.append(input, slider);
    group.append(label, toggle);
    if (hintText) {
      const hint = document.createElement('small');
      hint.className = 'form-hint';
      hint.textContent = hintText;
      group.appendChild(hint);
    }
    return group;
  };

  // ── 轉錄後端 ──
  container.appendChild(selectGroup(
    '轉錄後端',
    [
      { value: 'local_whisper', label: '本地 Whisper（音訊不離開電腦）' },
      { value: 'voxnote_asr', label: 'VoxNote 轉錄服務' },
    ],
    config.live_caption_backend || 'local_whisper',
    (value) => {
      config = { ...config, live_caption_backend: value as AppConfig['live_caption_backend'] };
      onChange(config);
      updateBackendVisibility(value);
    },
  ));

  // ── 來源語言 ──
  container.appendChild(selectGroup(
    '來源語言',
    [
      { value: 'auto', label: '自動偵測' },
      { value: 'zh', label: '中文（繁體/簡體）' },
      { value: 'en', label: '英文' },
      { value: 'ja', label: '日文' },
      { value: 'ko', label: '韓文' },
    ],
    config.live_caption_language || 'auto',
    (value) => {
      config = { ...config, live_caption_language: value };
      onChange(config);
    },
  ));
  const languageHint = document.createElement('small');
  languageHint.className = 'form-hint';
  languageHint.textContent = '此為即時字幕專屬的來源語言，與「設定」頁批次逐字稿的轉錄語言各自獨立、互不影響。';
  container.appendChild(languageHint);

  // ── 遠端端點（VoxNote 轉錄服務專用）──
  const remoteSection = document.createElement('div');
  const remoteUrlGroup = document.createElement('div');
  remoteUrlGroup.className = 'form-group';
  const remoteUrlLabel = document.createElement('label');
  remoteUrlLabel.textContent = '即時字幕遠端服務 Base URL';
  const remoteUrlInput = document.createElement('input');
  remoteUrlInput.type = 'url';
  remoteUrlInput.className = 'form-control';
  remoteUrlInput.value = config.live_caption_remote_base_url || '';
  remoteUrlInput.placeholder = '留空則沿用批次逐字稿的自架 ASR 位址';
  remoteUrlInput.addEventListener('input', () => {
    config = { ...config, live_caption_remote_base_url: remoteUrlInput.value };
    onChange(config);
  });
  remoteUrlGroup.append(remoteUrlLabel, remoteUrlInput);
  const remoteUrlHint = document.createElement('small');
  remoteUrlHint.className = 'form-hint';
  remoteUrlHint.textContent = '可指向載入不同模型的另一服務實例（例如英文低延遲模型），與「設定」頁批次逐字稿所用的位址分開設定。';
  remoteUrlGroup.appendChild(remoteUrlHint);
  remoteSection.appendChild(remoteUrlGroup);

  const remoteModelGroup = document.createElement('div');
  remoteModelGroup.className = 'form-group';
  const remoteModelLabel = document.createElement('label');
  remoteModelLabel.textContent = '遠端模型名稱（選填）';
  const remoteModelInput = document.createElement('input');
  remoteModelInput.type = 'text';
  remoteModelInput.className = 'form-control';
  remoteModelInput.value = config.live_caption_remote_model || '';
  remoteModelInput.placeholder = '依服務端設定，留空則使用服務端預設模型';
  remoteModelInput.addEventListener('input', () => {
    config = { ...config, live_caption_remote_model: remoteModelInput.value };
    onChange(config);
  });
  remoteModelGroup.append(remoteModelLabel, remoteModelInput);
  remoteSection.appendChild(remoteModelGroup);

  remoteSection.appendChild(numberGroup(
    '即時逾時（秒）',
    config.live_caption_remote_timeout_seconds || 8,
    1,
    30,
    1,
    (value) => {
      config = { ...config, live_caption_remote_timeout_seconds: value };
      onChange(config);
    },
    '單一視窗請求超過此秒數即放棄該段並繼續處理後續音訊，與批次逐字稿的逾時分開設定。',
  ));
  container.appendChild(remoteSection);

  // ── 模型檔 ──
  const modelGroup = document.createElement('div');
  modelGroup.className = 'form-group';
  const modelLabel = document.createElement('label');
  modelLabel.textContent = 'GGML 模型檔（.bin）';
  const modelRow = document.createElement('div');
  modelRow.className = 'directory-picker-row';
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelInput.className = 'form-control';
  modelInput.readOnly = true;
  modelInput.value = config.live_caption_model_path || '';
  modelInput.placeholder = '請選擇 ggml-small.bin 或 ggml-medium.bin';
  const modelButton = document.createElement('button');
  modelButton.type = 'button';
  modelButton.className = 'btn btn-secondary btn-sm';
  modelButton.textContent = '選擇檔案';
  modelButton.addEventListener('click', async () => {
    const selected = await openDialog({
      multiple: false,
      title: '選擇即時字幕 GGML 模型',
      filters: [{ name: 'Whisper GGML 模型', extensions: ['bin'] }],
    });
    if (typeof selected === 'string') {
      modelInput.value = selected;
      config = { ...config, live_caption_model_path: selected };
      onChange(config);
    }
  });
  modelRow.append(modelInput, modelButton);
  modelGroup.append(modelLabel, modelRow);
  const modelHint = document.createElement('small');
  modelHint.className = 'form-hint';
  modelHint.textContent = '模型需自行下載；建議 small 或 medium。';
  modelGroup.appendChild(modelHint);
  container.appendChild(modelGroup);

  // ── 顯示相關 ──
  container.appendChild(selectGroup(
    '字幕顯示模式',
    [
      { value: 'translation', label: '僅顯示譯文' },
      { value: 'original', label: '僅顯示原文' },
      { value: 'both', label: '原文與譯文並列' },
    ],
    config.live_caption_display_mode || 'translation',
    (value) => {
      config = { ...config, live_caption_display_mode: value as AppConfig['live_caption_display_mode'] };
      onChange(config);
    },
  ));

  container.appendChild(toggleGroup(
    '翻譯成繁體中文',
    config.live_caption_translate !== false,
    (checked) => {
      config = { ...config, live_caption_translate: checked };
      onChange(config);
    },
    '需要 LLM 供應商可連線；翻譯失敗時回退顯示原文。來源語言為中文時不會呼叫翻譯（無須把中文譯成中文），可改用下方的校稿。',
  ));

  container.appendChild(toggleGroup(
    '校稿（修正同音字、標點、斷句）',
    config.live_caption_proofread === true,
    (checked) => {
      config = { ...config, live_caption_proofread: checked };
      onChange(config);
    },
    '僅在來源語言為中文時生效，輸出仍為中文，不是翻譯；來源語言為其他語言或自動偵測時，此開關不影響結果。',
  ));

  container.appendChild(selectGroup(
    '字幕字級',
    [
      { value: '20', label: '小' },
      { value: '24', label: '中' },
      { value: '28', label: '大' },
      { value: '36', label: '特大' },
    ],
    String(nearestFontSizePreset(config.live_caption_font_size || 28)),
    (value) => {
      config = { ...config, live_caption_font_size: Number(value) };
      onChange(config);
    },
  ));
  const fontSizeHint = document.createElement('small');
  fontSizeHint.className = 'form-hint';
  fontSizeHint.textContent = '同時顯示的段數由字幕視窗大小自動決定，拖曳視窗邊框調整即可，無須另外設定行數。';
  container.appendChild(fontSizeHint);

  container.appendChild(numberGroup(
    '無語音清空秒數',
    config.live_caption_clear_seconds ?? 8,
    0,
    60,
    1,
    (value) => {
      config = { ...config, live_caption_clear_seconds: value };
      onChange(config);
    },
    '超過此秒數沒有新字幕即清空畫面；設為 0 代表不自動清空。',
  ));

  container.appendChild(toggleGroup(
    '字幕視窗點擊穿透',
    config.live_caption_click_through !== false,
    (checked) => {
      config = { ...config, live_caption_click_through: checked };
      onChange(config);
    },
    '開啟後滑鼠可直接操作字幕下方的影片；游標移到標題列或視窗邊框時會自動恢復互動，供拖曳與調整大小。',
  ));

  // ── 視窗長度情境預設 ──
  // 主要操作路徑：使用者選情境即可，不需理解「視窗長度」「步進」的意義。
  // 精確調整仍保留在下方的進階區塊，供想直接輸入秒數的使用者使用。
  const sceneGroup = document.createElement('div');
  sceneGroup.className = 'form-group';
  const sceneLabel = document.createElement('label');
  sceneLabel.textContent = '字幕情境';
  const sceneSelect = document.createElement('select');
  sceneSelect.className = 'form-control';
  for (const preset of WINDOW_SCENE_PRESETS) {
    const option = document.createElement('option');
    option.value = preset.value;
    option.textContent = preset.label;
    sceneSelect.appendChild(option);
  }
  const customOption = document.createElement('option');
  customOption.value = CUSTOM_WINDOW_SCENE;
  customOption.textContent = '自訂';
  // 「自訂」僅為狀態顯示（手動調整後的數值不匹配任何情境時顯示），
  // 不可被使用者主動選取——選取它沒有對應的秒數可套用，等於無效選項。
  customOption.disabled = true;
  sceneSelect.appendChild(customOption);
  sceneGroup.appendChild(sceneLabel);
  sceneGroup.appendChild(sceneSelect);
  const sceneHint = document.createElement('small');
  sceneHint.className = 'form-hint';
  sceneHint.textContent = '語速快、字幕常在句中被切斷時選較長的情境；想盡快看到字可選較短的情境。可於下方「進階字幕參數」精確調整。';
  sceneGroup.appendChild(sceneHint);
  container.appendChild(sceneGroup);

  // ── 進階參數 ──
  const advancedDetails = document.createElement('details');
  advancedDetails.className = 'settings-inline-details';
  const advancedSummary = document.createElement('summary');
  advancedSummary.textContent = '進階字幕參數';
  advancedDetails.appendChild(advancedSummary);
  const advancedBody = document.createElement('div');
  advancedBody.className = 'settings-inline-body';
  advancedDetails.appendChild(advancedBody);
  container.appendChild(advancedDetails);

  const windowSecondsGroup = document.createElement('div');
  windowSecondsGroup.className = 'form-group';
  const windowSecondsLabel = document.createElement('label');
  windowSecondsLabel.textContent = '視窗長度（秒）';
  const windowSecondsInput = document.createElement('input');
  windowSecondsInput.type = 'number';
  windowSecondsInput.className = 'form-control';
  windowSecondsInput.min = '1';
  windowSecondsInput.max = '30';
  windowSecondsInput.step = '1';
  windowSecondsInput.value = String(config.live_caption_window_seconds || 5);
  windowSecondsGroup.append(windowSecondsLabel, windowSecondsInput);
  const windowSecondsHint = document.createElement('small');
  windowSecondsHint.className = 'form-hint';
  windowSecondsHint.textContent = '每次送交辨識的音訊長度；過短會降低辨識準確度。';
  windowSecondsGroup.appendChild(windowSecondsHint);
  advancedBody.appendChild(windowSecondsGroup);

  const stepSecondsGroup = document.createElement('div');
  stepSecondsGroup.className = 'form-group';
  const stepSecondsLabel = document.createElement('label');
  stepSecondsLabel.textContent = '步進（秒）';
  const stepSecondsInput = document.createElement('input');
  stepSecondsInput.type = 'number';
  stepSecondsInput.className = 'form-control';
  stepSecondsInput.min = '1';
  stepSecondsInput.max = '30';
  stepSecondsInput.step = '1';
  stepSecondsInput.value = String(config.live_caption_step_seconds || 3);
  stepSecondsGroup.append(stepSecondsLabel, stepSecondsInput);
  const stepSecondsHint = document.createElement('small');
  stepSecondsHint.className = 'form-hint';
  stepSecondsHint.textContent = '每隔多久輸出一次字幕；必須小於或等於視窗長度。';
  stepSecondsGroup.appendChild(stepSecondsHint);
  advancedBody.appendChild(stepSecondsGroup);

  // 情境選單 → 兩個數值輸入：套用預設值。
  // 注意：這裡直接寫 .value 而不 dispatchEvent('change')——兩個輸入框各自的
  // change handler 也會寫 config／呼叫 syncSceneFromValues，若在此觸發會造成
  // 情境選單被 syncSceneFromValues 立即覆寫回去，形成無謂的往返。
  // config 已在此處原子性地一次寫入兩個欄位，不需要靠輸入框的 handler 補寫。
  sceneSelect.addEventListener('change', () => {
    const preset = WINDOW_SCENE_PRESETS.find((item) => item.value === sceneSelect.value);
    if (!preset) return; // 使用者選「自訂」時不代表任何數值，不做變更。
    windowSecondsInput.value = String(preset.windowSeconds);
    stepSecondsInput.value = String(preset.stepSeconds);
    config = {
      ...config,
      live_caption_window_seconds: preset.windowSeconds,
      live_caption_step_seconds: preset.stepSeconds,
    };
    onChange(config);
  });

  // 兩個數值輸入 → 情境選單：手動調整時同步回報目前對應哪個情境（或「自訂」）。
  const syncSceneFromValues = (): void => {
    const windowSeconds = Number(windowSecondsInput.value);
    const stepSeconds = Number(stepSecondsInput.value);
    sceneSelect.value = matchWindowScene(windowSeconds, stepSeconds);
  };
  windowSecondsInput.addEventListener('change', () => {
    const next = Number(windowSecondsInput.value);
    if (Number.isFinite(next)) {
      // 步進不得大於視窗長度（後端 validate_caption_window 會拒絕啟動）；
      // 縮小視窗時若原步進已超出新視窗長度，一併收緊，避免存下無法啟動的組合。
      const clampedStep = Math.min(Number(stepSecondsInput.value) || 3, next);
      if (clampedStep !== Number(stepSecondsInput.value)) {
        stepSecondsInput.value = String(clampedStep);
      }
      config = { ...config, live_caption_window_seconds: next, live_caption_step_seconds: clampedStep };
      onChange(config);
    }
    syncSceneFromValues();
  });
  stepSecondsInput.addEventListener('change', () => {
    const next = Number(stepSecondsInput.value);
    if (Number.isFinite(next)) {
      // 反向同理：步進不得大於視窗長度，調大步進時若已超出視窗長度，
      // 一併調大視窗長度以維持合法組合（而非反向收緊步進，避免使用者
      // 剛設定的值被自己的操作覆蓋，體感更符合「補足」而非「拒絕」）。
      const clampedWindow = Math.max(Number(windowSecondsInput.value) || 5, next);
      if (clampedWindow !== Number(windowSecondsInput.value)) {
        windowSecondsInput.value = String(clampedWindow);
      }
      config = { ...config, live_caption_step_seconds: next, live_caption_window_seconds: clampedWindow };
      onChange(config);
    }
    syncSceneFromValues();
  });
  syncSceneFromValues();

  advancedBody.appendChild(numberGroup(
    '靜音門檻（0 至 1）',
    config.live_caption_silence_threshold ?? 0.01,
    0,
    1,
    0.001,
    (value) => {
      config = { ...config, live_caption_silence_threshold: value };
      onChange(config);
    },
    '音量峰值低於此值的片段直接略過，不送交辨識。',
  ));

  const gpuStatus = document.createElement('small');
  gpuStatus.className = 'form-hint';
  gpuStatus.textContent = '正在確認 GPU 加速建置狀態…';
  void getLiveCaptionBuildInfo()
    .then((info) => {
      gpuStatus.textContent = info.cuda_enabled
        ? '目前建置已包含 CUDA GPU 加速。'
        : '目前建置未包含 CUDA，將使用 CPU 進行本地 Whisper 推論。';
    })
    .catch(() => {
      gpuStatus.textContent = '無法取得 GPU 加速建置狀態。';
    });
  advancedBody.appendChild(gpuStatus);

  const updateBackendVisibility = (backend: string): void => {
    modelGroup.style.display = backend === 'local_whisper' ? '' : 'none';
    remoteSection.style.display = backend === 'voxnote_asr' ? '' : 'none';
  };
  updateBackendVisibility(config.live_caption_backend || 'local_whisper');

  return container;
}
