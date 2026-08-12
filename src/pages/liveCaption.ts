import {
  getLiveCaptionStatus,
  listLiveCaptionAudioSources,
  listenLiveCaptionError,
  listenLiveCaptionStatus,
  startLiveCaption,
  stopLiveCaption,
} from '../api/liveCaption';
import type { AppConfig, LiveCaptionStatus, RecordingDeviceList } from '../types';
import { showToast } from '../components/toast';
import { buildLiveCaptionSettings } from '../components/liveCaptionSettings';
import { getSettings, saveSettings } from '../api/settings';
import { initConfigStore, setCurrentConfig } from '../utils/configStore';

let pageCleanup: (() => void) | null = null;

export async function renderLiveCaptionPage(container: HTMLElement): Promise<void> {
  pageCleanup?.();
  pageCleanup = null;
  container.innerHTML = '<div class="loading">載入即時字幕設定中...</div>';

  let config: AppConfig;
  let devices: RecordingDeviceList;
  try {
    [config, devices] = await Promise.all([initConfigStore(), listLiveCaptionAudioSources()]);
  } catch (error) {
    container.innerHTML = `<div class="error-state">載入即時字幕設定失敗：${String(error)}</div>`;
    return;
  }

  container.innerHTML = '';
  const toolbar = document.createElement('div');
  toolbar.className = 'page-toolbar';
  const title = document.createElement('h2');
  title.className = 'page-title';
  title.textContent = '即時字幕';
  toolbar.appendChild(title);
  container.appendChild(toolbar);

  const card = document.createElement('section');
  card.className = 'live-caption-panel';
  container.appendChild(card);

  const intro = document.createElement('p');
  intro.className = 'live-caption-intro';
  intro.textContent = '將字幕視窗拖到影片或會議畫面上方。字幕只在本次 session 中保留，不會寫入錄音或逐字稿。';
  card.appendChild(intro);

  const sourceGroup = document.createElement('div');
  sourceGroup.className = 'form-group';
  const sourceLabel = document.createElement('label');
  sourceLabel.textContent = '音訊來源';
  const sourceSelect = document.createElement('select');
  sourceSelect.className = 'form-control';
  const systemOption = document.createElement('option');
  systemOption.value = 'system';
  systemOption.textContent = '電腦音訊（系統播放聲音）';
  systemOption.disabled = !devices.system_audio_supported;
  sourceSelect.appendChild(systemOption);
  const microphoneOption = document.createElement('option');
  microphoneOption.value = 'microphone';
  microphoneOption.textContent = '麥克風';
  sourceSelect.appendChild(microphoneOption);
  sourceSelect.value = devices.system_audio_supported
    ? (config.live_caption_audio_source || 'system')
    : 'microphone';
  sourceGroup.append(sourceLabel, sourceSelect);
  card.appendChild(sourceGroup);

  const deviceHint = document.createElement('small');
  deviceHint.className = 'form-hint';
  const microphoneNames = devices.microphones.map((device) => device.name).join('、');
  const systemNames = devices.system_outputs.map((device) => device.name).join('、');
  deviceHint.textContent = devices.system_audio_supported
    ? `可用麥克風：${microphoneNames || '未偵測到'}；系統輸出：${systemNames || '預設裝置'}`
    : `目前平台不支援系統音訊；可用麥克風：${microphoneNames || '未偵測到'}`;
  card.appendChild(deviceHint);

  // 設定改由本頁直接提供；變更僅在下次啟動字幕時生效，故啟動前一律先寫入設定檔。
  let pendingConfig: AppConfig = config;
  let dirty = false;
  let currentActive = false;

  const restartHint = document.createElement('p');
  restartHint.className = 'form-hint live-caption-restart-hint';
  restartHint.textContent = '設定已變更，需停止並重新開始字幕才會套用。';
  restartHint.hidden = true;

  // 僅取出即時字幕欄位：設定元件持有的是頁面載入當下的完整快照，
  // 整包覆寫會把其他頁面在這之後所做的變更一併回退。
  const settingsPanel = buildLiveCaptionSettings(config, (updated) => {
    pendingConfig = {
      ...pendingConfig,
      live_caption_backend: updated.live_caption_backend,
      live_caption_model_path: updated.live_caption_model_path,
      live_caption_language: updated.live_caption_language,
      live_caption_remote_base_url: updated.live_caption_remote_base_url,
      live_caption_remote_model: updated.live_caption_remote_model,
      live_caption_remote_timeout_seconds: updated.live_caption_remote_timeout_seconds,
      live_caption_window_seconds: updated.live_caption_window_seconds,
      live_caption_step_seconds: updated.live_caption_step_seconds,
      live_caption_silence_threshold: updated.live_caption_silence_threshold,
      live_caption_translate: updated.live_caption_translate,
      live_caption_proofread: updated.live_caption_proofread,
      live_caption_display_mode: updated.live_caption_display_mode,
      live_caption_font_size: updated.live_caption_font_size,
      live_caption_clear_seconds: updated.live_caption_clear_seconds,
      live_caption_click_through: updated.live_caption_click_through,
    };
    setCurrentConfig(pendingConfig);
    dirty = true;
    restartHint.hidden = !currentActive;
  });

  const settingsDetails = document.createElement('details');
  settingsDetails.className = 'live-caption-settings-details';
  const settingsSummary = document.createElement('summary');
  settingsSummary.textContent = '字幕設定';
  settingsDetails.append(settingsSummary, settingsPanel);
  card.appendChild(settingsDetails);
  card.appendChild(restartHint);

  const status = document.createElement('div');
  status.className = 'live-caption-status';
  card.appendChild(status);

  const errorBox = document.createElement('div');
  errorBox.className = 'live-caption-error';
  errorBox.hidden = true;
  card.appendChild(errorBox);

  const actions = document.createElement('div');
  actions.className = 'live-caption-actions';
  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.className = 'btn btn-primary';
  startButton.textContent = '開始即時字幕';
  const stopButton = document.createElement('button');
  stopButton.type = 'button';
  stopButton.className = 'btn btn-danger';
  stopButton.textContent = '停止字幕';
  actions.append(startButton, stopButton);
  card.appendChild(actions);

  const setStatus = (current: LiveCaptionStatus): void => {
    currentActive = current.active;
    status.textContent = current.active ? '狀態：進行中，字幕視窗已開啟' : '狀態：未啟動';
    startButton.disabled = current.active;
    stopButton.disabled = !current.active;
    sourceSelect.disabled = current.active;
    // 未啟動時重新開始就會套用設定，不需再提示。
    if (!current.active) restartHint.hidden = true;
  };

  let disposed = false;
  const unlisteners: Array<() => void> = [];
  pageCleanup = () => {
    disposed = true;
    for (const unlisten of unlisteners) unlisten();
    pageCleanup = null;
  };

  const listenerPromises = [
    listenLiveCaptionStatus((current) => {
      if (!disposed) setStatus(current);
    }).then((unlisten) => unlisteners.push(unlisten)),
    listenLiveCaptionError((payload) => {
      if (disposed) return;
      errorBox.hidden = false;
      errorBox.textContent = payload.message;
      showToast(payload.message, 'warning', 5000);
    }).then((unlisten) => unlisteners.push(unlisten)),
  ];
  void Promise.all(listenerPromises);

  try {
    setStatus(await getLiveCaptionStatus());
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = `無法取得字幕狀態：${String(error)}`;
  }

  startButton.addEventListener('click', async () => {
    errorBox.hidden = true;
    startButton.disabled = true;
    try {
      // 後端在啟動時才讀取設定檔，故必須先確定變更已落盤，否則本次啟動會沿用舊值。
      const source = sourceSelect.value as 'microphone' | 'system';
      pendingConfig = { ...pendingConfig, live_caption_audio_source: source };
      setCurrentConfig(pendingConfig);
      if (dirty || pendingConfig.live_caption_audio_source !== config.live_caption_audio_source) {
        // 以最新的設定檔為底再套上本頁的即時字幕欄位，避免覆寫其他頁面的變更。
        const latest = await getSettings();
        const merged: AppConfig = {
          ...latest,
          live_caption_backend: pendingConfig.live_caption_backend,
          live_caption_model_path: pendingConfig.live_caption_model_path,
          live_caption_language: pendingConfig.live_caption_language,
          live_caption_remote_base_url: pendingConfig.live_caption_remote_base_url,
          live_caption_remote_model: pendingConfig.live_caption_remote_model,
          live_caption_remote_timeout_seconds: pendingConfig.live_caption_remote_timeout_seconds,
          live_caption_audio_source: pendingConfig.live_caption_audio_source,
          live_caption_window_seconds: pendingConfig.live_caption_window_seconds,
          live_caption_step_seconds: pendingConfig.live_caption_step_seconds,
          live_caption_silence_threshold: pendingConfig.live_caption_silence_threshold,
          live_caption_translate: pendingConfig.live_caption_translate,
          live_caption_proofread: pendingConfig.live_caption_proofread,
          live_caption_display_mode: pendingConfig.live_caption_display_mode,
          live_caption_font_size: pendingConfig.live_caption_font_size,
          live_caption_clear_seconds: pendingConfig.live_caption_clear_seconds,
          live_caption_click_through: pendingConfig.live_caption_click_through,
        };
        await saveSettings(merged);
        pendingConfig = merged;
        config = merged;
        setCurrentConfig(merged);
        dirty = false;
        restartHint.hidden = true;
      }
      const current = await startLiveCaption(source);
      setStatus(current);
      showToast('即時字幕已啟動，請將浮動視窗拖到影片上方。', 'success');
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = `啟動失敗：${String(error)}`;
      showToast(`即時字幕啟動失敗：${String(error)}`, 'error', 5000);
      startButton.disabled = false;
    }
  });

  stopButton.addEventListener('click', async () => {
    stopButton.disabled = true;
    try {
      setStatus(await stopLiveCaption());
      showToast('即時字幕已停止。', 'success');
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = `停止失敗：${String(error)}`;
      showToast(`即時字幕停止失敗：${String(error)}`, 'error');
      stopButton.disabled = false;
    }
  });

}
