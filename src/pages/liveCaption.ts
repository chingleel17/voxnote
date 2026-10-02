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
import { buildSelectGroup } from '../components/selectGroup';
import { getSettings, saveSettings } from '../api/settings';
import { getCurrentConfig, initConfigStore, setCurrentConfig } from '../utils/configStore';
import { mergeLiveCaptionSettings } from '../utils/liveCaptionConfig';

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

  const sourceGroup = buildSelectGroup('音訊來源', [
    { value: 'system', label: '電腦音訊（系統播放聲音）', disabled: !devices.system_audio_supported },
    { value: 'microphone', label: '麥克風' },
  ], devices.system_audio_supported ? config.live_caption_audio_source : 'microphone', () => {});
  const sourceSelect = sourceGroup.select;
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
  let starting = false;
  let stopping = false;
  let startRequested = false;
  let cancellationRequested = false;
  let startingSessionId: string | null = null;
  let activeSessionId: string | null = null;

  const restartHint = document.createElement('p');
  restartHint.className = 'form-hint live-caption-restart-hint';
  restartHint.textContent = '設定已變更，需停止並重新開始字幕才會套用。';
  restartHint.hidden = true;

  // 僅取出即時字幕欄位：設定元件持有的是頁面載入當下的完整快照，
  // 整包覆寫會把其他頁面在這之後所做的變更一併回退。
  const settingsPanel = buildLiveCaptionSettings(config, (updated) => {
    pendingConfig = mergeLiveCaptionSettings(getCurrentConfig() ?? pendingConfig, updated);
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
    activeSessionId = current.session_id;
    status.textContent = current.active ? '狀態：進行中，字幕視窗已開啟' : '狀態：未啟動';
    startButton.disabled = current.active || starting || stopping;
    stopButton.disabled = stopping || (!current.active && !starting);
    sourceSelect.disabled = current.active || starting || stopping;
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
    starting = true;
    startRequested = false;
    cancellationRequested = false;
    startingSessionId = crypto.randomUUID();
    startButton.disabled = true;
    stopButton.disabled = false;
    sourceSelect.disabled = true;
    try {
      // 後端在啟動時才讀取設定檔，故必須先確定變更已落盤，否則本次啟動會沿用舊值。
      const source = sourceSelect.value as 'microphone' | 'system';
      pendingConfig = mergeLiveCaptionSettings(getCurrentConfig() ?? pendingConfig, {
        ...pendingConfig, live_caption_audio_source: source,
      });
      setCurrentConfig(pendingConfig);
      if (dirty || pendingConfig.live_caption_audio_source !== config.live_caption_audio_source) {
        const latest = getCurrentConfig() ?? await getSettings();
        const merged = mergeLiveCaptionSettings(latest, pendingConfig);
        await saveSettings(merged);
        pendingConfig = merged;
        config = merged;
        setCurrentConfig(merged);
        dirty = false;
        restartHint.hidden = true;
      }
      if (cancellationRequested) return;
      startRequested = true;
      const current = await startLiveCaption(source, startingSessionId);
      if (cancellationRequested) {
        if (current.active && current.session_id) setStatus(await stopLiveCaption(current.session_id));
        return;
      }
      setStatus(current);
      showToast('即時字幕已啟動，請將浮動視窗拖到影片上方。', 'success');
    } catch (error) {
      if (cancellationRequested) return;
      errorBox.hidden = false;
      errorBox.textContent = `啟動失敗：${String(error)}`;
      showToast(`即時字幕啟動失敗：${String(error)}`, 'error', 5000);
      startButton.disabled = false;
    } finally {
      starting = false;
      startRequested = false;
      startingSessionId = null;
      try {
        setStatus(await getLiveCaptionStatus());
      } catch {
        startButton.disabled = currentActive || stopping;
        stopButton.disabled = stopping || !currentActive;
        sourceSelect.disabled = currentActive || stopping;
      }
    }
  });

  stopButton.addEventListener('click', async () => {
    stopButton.disabled = true;
    if (starting) {
      cancellationRequested = true;
      if (!startRequested) return;
    }
    stopping = true;
    startButton.disabled = true;
    try {
      setStatus(await stopLiveCaption((starting ? startingSessionId : activeSessionId) ?? undefined));
      showToast('即時字幕已停止。', 'success');
    } catch (error) {
      if (starting && cancellationRequested) return;
      errorBox.hidden = false;
      errorBox.textContent = `停止失敗：${String(error)}`;
      showToast(`即時字幕停止失敗：${String(error)}`, 'error');
      stopButton.disabled = false;
    } finally {
      stopping = false;
      try {
        setStatus(await getLiveCaptionStatus());
      } catch {
        startButton.disabled = currentActive || starting;
        stopButton.disabled = !currentActive && !starting;
        sourceSelect.disabled = currentActive || starting;
      }
    }
  });

}
