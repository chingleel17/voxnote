import { convertFileSrc } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { stat } from '@tauri-apps/plugin-fs';
import type {
  Category,
  MeetingWithDetails,
  RecordingDeviceList,
  RecordingSourceMode,
  SavedParticipant,
  Tag,
} from '../types';
import { createMeeting, getCategories, getMeetings } from '../api/meetings';
import {
  cancelDesktopRecording,
  commitTemporaryRecording,
  discardTempRecordingFile,
  importRecordingFile,
  listRecordingDevices,
  startDesktopRecording,
  stopDesktopRecording,
} from '../api/recordings';
import { saveSettings } from '../api/settings';
import { getSavedParticipants, upsertSavedParticipant } from '../api/participants';
import { getTags } from '../api/tags';
import { openModal } from '../components/modal';
import { showToast } from '../components/toast';
import { createWaveformPlayer } from '../components/audioPlayer';
import { buildParticipantEditor } from '../components/participantEditor';
import { initConfigStore, setCurrentConfig } from '../utils/configStore';

interface RecordingState {
  isRecording: boolean;
  startTime: number;
  timerInterval: number | null;
  uploadedFilePath: string | null;
  uploadedFileName: string | null;
  previewObjectUrl: string | null;
  previewTempFilePath: string | null;
  previewDurationSeconds: number | null;
  previewSourceMode: RecordingSourceMode | null;
  previewNeedsCleanup: boolean;
  animationId: number | null;
  liveLevel: number;
  unlistenLevel: UnlistenFn | null;
}

const state: RecordingState = {
  isRecording: false,
  startTime: 0,
  timerInterval: null,
  uploadedFilePath: null,
  uploadedFileName: null,
  previewObjectUrl: null,
  previewTempFilePath: null,
  previewDurationSeconds: null,
  previewSourceMode: null,
  previewNeedsCleanup: false,
  animationId: null,
  liveLevel: 0,
  unlistenLevel: null,
};

function resetCanvas(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawStaticWaveform(canvas: HTMLCanvasElement, audioBuffer: AudioBuffer): void {
  const ctxOrNull = canvas.getContext('2d');
  if (!ctxOrNull) return;
  const ctx = ctxOrNull;

  const channelData = audioBuffer.getChannelData(0);
  const step = Math.ceil(channelData.length / canvas.width);

  resetCanvas(canvas);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#6366f1';
  ctx.beginPath();

  for (let i = 0; i < canvas.width; i++) {
    let max = 0;
    for (let j = 0; j < step; j++) {
      const sample = channelData[i * step + j] ?? 0;
      if (Math.abs(sample) > max) max = Math.abs(sample);
    }
    const y = ((1 - max) * canvas.height) / 2;
    if (i === 0) {
      ctx.moveTo(i, y);
    } else {
      ctx.lineTo(i, y);
    }
  }

  ctx.stroke();
}

function drawLiveLevel(canvas: HTMLCanvasElement, level: number, phase: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  resetCanvas(canvas);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#6366f1';
  ctx.beginPath();

  const amplitude = Math.max(0.08, Math.min(level, 1)) * (canvas.height * 0.38);
  const centerY = canvas.height / 2;
  const step = Math.max(4, Math.floor(canvas.width / 90));

  for (let x = 0; x <= canvas.width; x += step) {
    const wave = Math.sin((x / canvas.width) * Math.PI * 8 + phase) * amplitude;
    const y = centerY + wave;
    if (x === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

function formatTime(secs: number): string {
  if (!isFinite(secs) || Number.isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatMeetingDate(meeting: MeetingWithDetails): string {
  return new Date(meeting.meeting_date ?? meeting.created_at).toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

async function releasePreviewResources(): Promise<void> {
  if (state.previewNeedsCleanup && state.previewTempFilePath) {
    try {
      await discardTempRecordingFile(state.previewTempFilePath);
    } catch {
      // 失敗時由啟動時清理暫存檔補救
    }
  }

  if (state.previewObjectUrl) {
    URL.revokeObjectURL(state.previewObjectUrl);
  }

  state.previewObjectUrl = null;
  state.previewTempFilePath = null;
  state.previewDurationSeconds = null;
  state.previewSourceMode = null;
  state.previewNeedsCleanup = false;
  state.uploadedFilePath = null;
  state.uploadedFileName = null;
}

async function stopAllRecordingState(): Promise<void> {
  if (state.timerInterval !== null) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.animationId !== null) {
    cancelAnimationFrame(state.animationId);
    state.animationId = null;
  }
  if (state.unlistenLevel) {
    state.unlistenLevel();
    state.unlistenLevel = null;
  }
  if (state.isRecording) {
    try {
      await cancelDesktopRecording();
    } catch {
      // 離開頁面時不中斷使用者流程
    }
  }
  state.isRecording = false;
  state.startTime = 0;
  state.liveLevel = 0;
  await releasePreviewResources();
}

export async function renderRecordPage(container: HTMLElement, preselectedMeetingId?: string): Promise<void> {
  await stopAllRecordingState();
  container.innerHTML = '';

  let meetings: MeetingWithDetails[] = [];
  let categories: Category[] = [];
  let savedParticipants: SavedParticipant[] = [];
  let allTags: Tag[] = [];
  let recordingDevices: RecordingDeviceList = {
    microphones: [],
    system_outputs: [],
    system_audio_supported: false,
  };
  let appConfig = await initConfigStore();

  try {
    [meetings, categories, savedParticipants, allTags, recordingDevices] = await Promise.all([
      getMeetings(),
      getCategories(),
      getSavedParticipants(),
      getTags(),
      listRecordingDevices(),
    ]);
  } catch {
    try {
      recordingDevices = await listRecordingDevices();
    } catch {
      recordingDevices = {
        microphones: [],
        system_outputs: [],
        system_audio_supported: false,
      };
    }
  }

  const persistRecordingPreferences = async (
    mode: RecordingSourceMode,
    microphoneDeviceId: string,
    systemDeviceId: string,
  ): Promise<void> => {
    appConfig = {
      ...appConfig,
      recording_source_mode: mode,
      recording_microphone_device_id: microphoneDeviceId,
      recording_system_device_id: systemDeviceId,
    };
    setCurrentConfig(appConfig);
    await saveSettings(appConfig);
  };

  const toolbar = document.createElement('div');
  toolbar.className = 'page-toolbar';
  const pageTitle = document.createElement('h2');
  pageTitle.className = 'page-title';
  pageTitle.textContent = '錄音';
  toolbar.appendChild(pageTitle);
  container.appendChild(toolbar);

  const wrapper = document.createElement('div');
  wrapper.className = 'record-wrapper';
  container.appendChild(wrapper);

  const meetingGroup = document.createElement('div');
  meetingGroup.className = 'form-group';
  const meetingLabel = document.createElement('label');
  meetingLabel.textContent = '選擇會議';
  const meetingSearchRow = document.createElement('div');
  meetingSearchRow.className = 'record-meeting-search-row';
  const meetingPicker = document.createElement('div');
  meetingPicker.className = 'meeting-picker';
  const meetingTrigger = document.createElement('button');
  meetingTrigger.type = 'button';
  meetingTrigger.className = 'meeting-picker-trigger';
  const meetingTriggerText = document.createElement('span');
  meetingTriggerText.className = 'meeting-picker-trigger-text';
  const meetingTriggerArrow = document.createElement('span');
  meetingTriggerArrow.className = 'meeting-picker-trigger-arrow';
  meetingTriggerArrow.textContent = '▾';
  meetingTrigger.appendChild(meetingTriggerText);
  meetingTrigger.appendChild(meetingTriggerArrow);
  const meetingDropdown = document.createElement('div');
  meetingDropdown.className = 'meeting-picker-dropdown hidden';
  const meetingSearchInput = document.createElement('input');
  meetingSearchInput.className = 'form-control';
  meetingSearchInput.placeholder = '搜尋會議名稱或日期';
  const meetingList = document.createElement('div');
  meetingList.className = 'meeting-picker-results';
  meetingDropdown.appendChild(meetingSearchInput);
  meetingDropdown.appendChild(meetingList);
  meetingPicker.appendChild(meetingTrigger);
  meetingPicker.appendChild(meetingDropdown);
  const createMeetingBtn = document.createElement('button');
  createMeetingBtn.className = 'btn btn-secondary btn-sm';
  createMeetingBtn.textContent = '新增會議';
  meetingSearchRow.appendChild(meetingPicker);
  meetingSearchRow.appendChild(createMeetingBtn);
  let selectedMeetingId = preselectedMeetingId ?? '';
  let isMeetingDropdownOpen = false;

  const syncMeetingTrigger = (): void => {
    const selectedMeeting = meetings.find((meeting) => meeting.id === selectedMeetingId);
    meetingTriggerText.textContent = selectedMeeting
      ? `${selectedMeeting.title}（${formatMeetingDate(selectedMeeting)}）`
      : '請選擇會議';
    meetingTrigger.classList.toggle('placeholder', !selectedMeeting);
  };

  const setMeetingDropdownOpen = (open: boolean): void => {
    isMeetingDropdownOpen = open;
    meetingDropdown.classList.toggle('hidden', !open);
    meetingPicker.classList.toggle('open', open);
    meetingTriggerArrow.textContent = open ? '▴' : '▾';
    if (open) {
      meetingSearchInput.value = '';
      renderMeetingList();
      window.setTimeout(() => meetingSearchInput.focus(), 0);
    }
  };

  const renderMeetingList = (): void => {
    const keyword = meetingSearchInput.value.trim().toLowerCase();
    meetingList.innerHTML = '';
    const filteredMeetings = meetings.filter((meeting) => {
      if (!keyword) return true;
      const dateText = formatMeetingDate(meeting).toLowerCase();
      return meeting.title.toLowerCase().includes(keyword) || dateText.includes(keyword);
    });

    if (filteredMeetings.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'meeting-picker-empty';
      empty.textContent = '找不到符合的會議';
      meetingList.appendChild(empty);
    }

    for (const meeting of filteredMeetings) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = `meeting-picker-option${selectedMeetingId === meeting.id ? ' active' : ''}`;
      const title = document.createElement('span');
      title.className = 'meeting-picker-title';
      title.textContent = meeting.title;
      const badge = document.createElement('span');
      badge.className = 'badge badge-category';
      badge.textContent = formatMeetingDate(meeting);
      option.appendChild(title);
      option.appendChild(badge);
      option.addEventListener('click', () => {
        selectedMeetingId = meeting.id;
        syncMeetingTrigger();
        setMeetingDropdownOpen(false);
      });
      meetingList.appendChild(option);
    }
  };

  meetingSearchInput.addEventListener('input', renderMeetingList);
  meetingTrigger.addEventListener('click', () => {
    setMeetingDropdownOpen(!isMeetingDropdownOpen);
  });
  const handleDocumentClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Node)) return;
    if (!meetingSearchRow.contains(event.target)) {
      setMeetingDropdownOpen(false);
    }
  };
  document.addEventListener('click', handleDocumentClick);
  window.addEventListener(
    'hashchange',
    () => {
      document.removeEventListener('click', handleDocumentClick);
      void stopAllRecordingState();
    },
    { once: true },
  );
  meetingGroup.appendChild(meetingLabel);
  meetingGroup.appendChild(meetingSearchRow);
  wrapper.appendChild(meetingGroup);

  if (preselectedMeetingId) {
    const selectedMeeting = meetings.find((meeting) => meeting.id === preselectedMeetingId);
    if (selectedMeeting) {
      selectedMeetingId = selectedMeeting.id;
    }
  }
  syncMeetingTrigger();
  renderMeetingList();

  createMeetingBtn.addEventListener('click', () => {
    const form = document.createElement('div');
    form.className = 'form-group-list';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'form-group';
    const titleLabel = document.createElement('label');
    titleLabel.textContent = '會議標題';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'form-control';
    titleInput.placeholder = '請輸入會議標題';
    titleGroup.appendChild(titleLabel);
    titleGroup.appendChild(titleInput);
    form.appendChild(titleGroup);

    const categoryGroup = document.createElement('div');
    categoryGroup.className = 'form-group';
    const categoryLabel = document.createElement('label');
    categoryLabel.textContent = '分類';
    const categorySelect = document.createElement('select');
    categorySelect.className = 'form-control';
    const emptyCategoryOption = document.createElement('option');
    emptyCategoryOption.value = '';
    emptyCategoryOption.textContent = '-- 無分類 --';
    categorySelect.appendChild(emptyCategoryOption);
    for (const category of categories) {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = category.name;
      categorySelect.appendChild(option);
    }
    categoryGroup.appendChild(categoryLabel);
    categoryGroup.appendChild(categorySelect);
    form.appendChild(categoryGroup);

    let selectedTagIds: Set<string> = new Set();
    const tagGroup = document.createElement('div');
    tagGroup.className = 'form-group';
    const tagLabel = document.createElement('label');
    tagLabel.textContent = '標籤（可複選）';
    tagGroup.appendChild(tagLabel);
    if (allTags.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'empty-hint';
      hint.textContent = '尚無標籤，可先到管理頁建立。';
      tagGroup.appendChild(hint);
    } else {
      const tagCheckboxes = document.createElement('div');
      tagCheckboxes.className = 'tag-checkbox-list';
      for (const tag of allTags) {
        const row = document.createElement('label');
        row.className = 'tag-checkbox-row';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedTagIds.add(tag.id);
          else selectedTagIds.delete(tag.id);
        });
        const swatch = document.createElement('span');
        swatch.className = 'tag-swatch';
        swatch.style.backgroundColor = tag.color;
        row.appendChild(checkbox);
        row.appendChild(swatch);
        row.appendChild(document.createTextNode(tag.name));
        tagCheckboxes.appendChild(row);
      }
      tagGroup.appendChild(tagCheckboxes);
    }
    form.appendChild(tagGroup);

    const participantEditor = buildParticipantEditor([], savedParticipants, {
      allowManageSaved: true,
      onSavedParticipantsChanged: (updated) => {
        savedParticipants = updated;
      },
    });
    form.appendChild(participantEditor.el);

    openModal({
      title: '新增會議',
      content: form,
      confirmText: '建立',
      cancelText: '取消',
      onConfirm: async () => {
        const title = titleInput.value.trim();
        if (!title) {
          titleInput.focus();
          return false;
        }
        try {
          const participants = participantEditor.getParticipants();
          const meeting = await createMeeting({
            title,
            category_id: categorySelect.value || null,
            participants,
            tag_ids: Array.from(selectedTagIds),
          });
          meetings.unshift(meeting);
          await Promise.all(participants.map((name) => upsertSavedParticipant(name)));
          savedParticipants = await getSavedParticipants();
          selectedMeetingId = meeting.id;
          syncMeetingTrigger();
          setMeetingDropdownOpen(false);
          renderMeetingList();
          showToast('會議已建立', 'success');
        } catch (err) {
          showToast(`建立失敗：${String(err)}`, 'error');
          return false;
        }
      },
    });
  });

  const modeGroup = document.createElement('div');
  modeGroup.className = 'form-group';
  const modeLabel = document.createElement('label');
  modeLabel.textContent = '錄音來源';
  const modeSelect = document.createElement('select');
  modeSelect.className = 'form-control';
  const modeOptions: Array<{ value: RecordingSourceMode; label: string }> = [
    { value: 'microphone', label: '僅麥克風' },
    { value: 'system', label: '僅電腦音訊' },
    { value: 'mix', label: '麥克風 + 電腦音訊混音' },
  ];
  for (const option of modeOptions) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    modeSelect.appendChild(el);
  }
  modeSelect.value = appConfig.recording_source_mode ?? 'microphone';
  modeGroup.appendChild(modeLabel);
  modeGroup.appendChild(modeSelect);
  wrapper.appendChild(modeGroup);

  const micGroup = document.createElement('div');
  micGroup.className = 'form-group';
  const micLabel = document.createElement('label');
  micLabel.textContent = '麥克風';
  const micSelect = document.createElement('select');
  micSelect.className = 'form-control';
  if (recordingDevices.microphones.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '找不到可用麥克風';
    micSelect.appendChild(option);
  } else {
    for (const device of recordingDevices.microphones) {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.is_default ? `${device.name}（預設）` : device.name;
      micSelect.appendChild(option);
    }
  }
  micSelect.value =
    appConfig.recording_microphone_device_id ||
    recordingDevices.microphones.find((device) => device.is_default)?.id ||
    recordingDevices.microphones[0]?.id ||
    '';
  micGroup.appendChild(micLabel);
  micGroup.appendChild(micSelect);
  wrapper.appendChild(micGroup);

  const systemGroup = document.createElement('div');
  systemGroup.className = 'form-group';
  const systemLabel = document.createElement('label');
  systemLabel.textContent = '電腦音訊來源';
  const systemSelect = document.createElement('select');
  systemSelect.className = 'form-control';
  if (recordingDevices.system_outputs.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = recordingDevices.system_audio_supported ? '目前找不到輸出裝置' : '此平台尚未支援';
    systemSelect.appendChild(option);
  } else {
    for (const device of recordingDevices.system_outputs) {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.is_default ? `${device.name}（預設）` : device.name;
      systemSelect.appendChild(option);
    }
  }
  systemSelect.value =
    appConfig.recording_system_device_id ||
    recordingDevices.system_outputs.find((device) => device.is_default)?.id ||
    recordingDevices.system_outputs[0]?.id ||
    '';
  systemGroup.appendChild(systemLabel);
  systemGroup.appendChild(systemSelect);
  wrapper.appendChild(systemGroup);

  const supportHint = document.createElement('small');
  supportHint.className = 'form-hint';
  wrapper.appendChild(supportHint);

  const canvas = document.createElement('canvas');
  canvas.className = 'waveform-canvas';
  canvas.width = 600;
  canvas.height = 100;
  resetCanvas(canvas);
  wrapper.appendChild(canvas);

  const timer = document.createElement('div');
  timer.className = 'record-timer';
  timer.textContent = '00:00';
  wrapper.appendChild(timer);

  const controlRow = document.createElement('div');
  controlRow.className = 'record-controls';

  const recordBtn = document.createElement('button');
  recordBtn.className = 'btn btn-record';
  recordBtn.textContent = '開始錄音';

  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'btn btn-secondary';
  uploadBtn.textContent = '上傳音訊';

  const reselectBtn = document.createElement('button');
  reselectBtn.className = 'btn btn-ghost hidden';
  reselectBtn.textContent = '重新選擇';

  controlRow.appendChild(recordBtn);
  controlRow.appendChild(uploadBtn);
  controlRow.appendChild(reselectBtn);
  wrapper.appendChild(controlRow);

  const playerSection = document.createElement('div');
  playerSection.className = 'record-player hidden';
  const playerTitle = document.createElement('p');
  playerTitle.className = 'player-hint';
  playerTitle.textContent = '錄音完成，請確認後儲存：';

  const audioEl = document.createElement('audio');
  audioEl.preload = 'metadata';
  audioEl.style.display = 'none';
  const customPlayerEl = createWaveformPlayer(audioEl);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = '儲存錄音';

  playerSection.appendChild(playerTitle);
  playerSection.appendChild(audioEl);
  playerSection.appendChild(customPlayerEl);
  playerSection.appendChild(saveBtn);
  wrapper.appendChild(playerSection);

  const syncSourceUi = (): void => {
    const mode = modeSelect.value as RecordingSourceMode;
    const needsMic = mode === 'microphone' || mode === 'mix';
    const needsSystem = mode === 'system' || mode === 'mix';
    micGroup.classList.toggle('hidden', !needsMic || state.uploadedFilePath !== null);
    systemGroup.classList.toggle('hidden', !needsSystem || state.uploadedFilePath !== null);

    if (needsSystem && !recordingDevices.system_audio_supported) {
      supportHint.textContent = '目前僅 Windows 支援電腦本地音訊錄音。請改用僅麥克風或上傳音訊檔案。';
      supportHint.style.color = 'var(--color-warning)';
    } else if (needsSystem) {
      supportHint.textContent = '電腦音訊會擷取目前系統預設播放裝置的聲音；戴耳機開會時也能收進錄音。';
      supportHint.style.color = '';
    } else {
      supportHint.textContent = '僅麥克風模式會透過桌面錄音引擎寫出 WAV，停止後可先預覽再儲存。';
      supportHint.style.color = '';
    }
  };

  const startVisualizer = (): void => {
    if (state.animationId !== null) {
      cancelAnimationFrame(state.animationId);
    }
    let phase = 0;
    const draw = (): void => {
      phase += 0.22;
      drawLiveLevel(canvas, state.liveLevel, phase);
      state.liveLevel *= 0.92;
      state.animationId = requestAnimationFrame(draw);
    };
    draw();
  };

  const showPreview = async (
    src: string,
    title: string,
    durationSeconds: number | null,
    tempFilePath: string | null,
    sourceMode: RecordingSourceMode | null,
    needsCleanup: boolean,
  ): Promise<void> => {
    state.previewDurationSeconds = durationSeconds;
    state.previewTempFilePath = tempFilePath;
    state.previewSourceMode = sourceMode;
    state.previewNeedsCleanup = needsCleanup;
    audioEl.src = src;
    playerTitle.textContent = title;
    playerSection.classList.remove('hidden');
    timer.textContent = durationSeconds ? formatTime(durationSeconds) : '00:00';
  };

  const resetToRecordingMode = async (): Promise<void> => {
    await releasePreviewResources();
    playerSection.classList.add('hidden');
    audioEl.src = '';
    timer.textContent = '00:00';
    recordBtn.classList.remove('hidden');
    uploadBtn.classList.remove('hidden');
    modeGroup.classList.remove('hidden');
    reselectBtn.classList.add('hidden');
    state.uploadedFilePath = null;
    state.uploadedFileName = null;
    resetCanvas(canvas);
    syncSourceUi();
  };

  const ensureLevelListener = async (): Promise<void> => {
    if (state.unlistenLevel) {
      return;
    }
    state.unlistenLevel = await listen<{ level: number; mode: RecordingSourceMode }>('recording-level', (event) => {
      state.liveLevel = Math.max(state.liveLevel, event.payload.level);
    });
  };

  recordBtn.addEventListener('click', async () => {
    if (!state.isRecording) {
      const mode = modeSelect.value as RecordingSourceMode;
      const microphoneDeviceId = micSelect.value;
      const systemDeviceId = systemSelect.value;

      if ((mode === 'system' || mode === 'mix') && !recordingDevices.system_audio_supported) {
        showToast('目前只有 Windows 支援電腦本地音訊錄音', 'warning');
        return;
      }
      if ((mode === 'microphone' || mode === 'mix') && !microphoneDeviceId) {
        showToast('請先選擇可用的麥克風', 'warning');
        return;
      }
      if ((mode === 'system' || mode === 'mix') && !systemDeviceId) {
        showToast('找不到可用的電腦音訊來源', 'warning');
        return;
      }

      recordBtn.disabled = true;
      try {
        await ensureLevelListener();
        await releasePreviewResources();
        await startDesktopRecording({
          mode,
          microphone_device_id: microphoneDeviceId || null,
          system_device_id: systemDeviceId || null,
        });
        await persistRecordingPreferences(mode, microphoneDeviceId, systemDeviceId);
        state.isRecording = true;
        state.startTime = Date.now();
        state.liveLevel = 0;
        recordBtn.textContent = '停止錄音';
        recordBtn.classList.add('recording');
        playerSection.classList.add('hidden');
        startVisualizer();
        state.timerInterval = window.setInterval(() => {
          const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
          timer.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
        }, 1000);
      } catch (err) {
        showToast(`開始錄音失敗：${String(err)}`, 'error');
      } finally {
        recordBtn.disabled = false;
      }
    } else {
      recordBtn.disabled = true;
      try {
        const preview = await stopDesktopRecording();
        state.isRecording = false;
        recordBtn.textContent = '開始錄音';
        recordBtn.classList.remove('recording');
        if (state.timerInterval !== null) {
          clearInterval(state.timerInterval);
          state.timerInterval = null;
        }
        if (state.animationId !== null) {
          cancelAnimationFrame(state.animationId);
          state.animationId = null;
        }
        timer.textContent = formatTime(preview.duration_seconds);
        await showPreview(
          convertFileSrc(preview.temp_file_path),
          '錄音完成，請確認後儲存：',
          preview.duration_seconds,
          preview.temp_file_path,
          preview.mode,
          true,
        );
        if (preview.warning) {
          showToast(`錄音已停止：${preview.warning}`, 'warning');
        }
      } catch (err) {
        showToast(`停止錄音失敗：${String(err)}`, 'error');
      } finally {
        recordBtn.disabled = false;
      }
    }
  });

  saveBtn.addEventListener('click', async () => {
    const meetingId = selectedMeetingId;
    if (!meetingId) {
      showToast('請先選擇會議', 'warning');
      return;
    }
    if (!audioEl.src) {
      showToast('尚無錄音檔案', 'warning');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = '儲存中…';

    try {
      if (state.uploadedFilePath) {
        const ext = (state.uploadedFileName ?? state.uploadedFilePath).split('.').pop() ?? 'wav';
        const fileName = `${meetingId}_${Date.now()}.${ext}`;
        await importRecordingFile(meetingId, state.uploadedFilePath, fileName, state.uploadedFileName, null);
      } else if (state.previewTempFilePath) {
        await commitTemporaryRecording(
          meetingId,
          state.previewTempFilePath,
          null,
          state.previewDurationSeconds,
          state.previewSourceMode,
        );
        state.previewNeedsCleanup = false;
      } else {
        throw new Error('找不到可儲存的錄音檔');
      }

      showToast('錄音已儲存', 'success');
      window.location.hash = `#meeting/${meetingId}`;
    } catch (err) {
      showToast(`儲存失敗：${String(err)}`, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = '儲存錄音';
      return;
    }
  });

  // 大於此門檻的音訊檔不進行整檔波形解碼，避免長錄音把 webview 記憶體撐爆
  const WAVEFORM_DECODE_SIZE_LIMIT = 100 * 1024 * 1024; // 100MB

  uploadBtn.addEventListener('click', async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: '音訊檔案', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'wma'] }],
    });
    if (!selected || Array.isArray(selected)) return;

    const filePath = selected;
    const fileName = filePath.split(/[/\\]/).pop() ?? filePath;

    await releasePreviewResources();
    state.uploadedFilePath = filePath;
    state.uploadedFileName = fileName;
    state.previewDurationSeconds = null;
    state.previewSourceMode = null;
    state.previewNeedsCleanup = false;
    state.previewTempFilePath = null;

    recordBtn.classList.add('hidden');
    uploadBtn.classList.add('hidden');
    micGroup.classList.add('hidden');
    systemGroup.classList.add('hidden');
    modeGroup.classList.add('hidden');
    reselectBtn.classList.remove('hidden');

    const src = convertFileSrc(filePath);
    await showPreview(src, `已載入音訊（${fileName}），請確認後儲存：`, null, null, null, false);

    const waveCtx = canvas.getContext('2d');
    if (waveCtx) {
      resetCanvas(canvas);
      waveCtx.fillStyle = '#6366f1';
      waveCtx.font = '14px sans-serif';
      waveCtx.textAlign = 'center';
      waveCtx.fillText('波形分析中…', canvas.width / 2, canvas.height / 2 + 5);
    }

    try {
      const info = await stat(filePath);
      if (info.size > WAVEFORM_DECODE_SIZE_LIMIT) {
        resetCanvas(canvas);
      } else {
        const response = await fetch(src);
        const arrayBuffer = await response.arrayBuffer();
        const audioCtx = new AudioContext();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        drawStaticWaveform(canvas, audioBuffer);
        timer.textContent = formatTime(audioBuffer.duration);
        await audioCtx.close();
      }
    } catch {
      resetCanvas(canvas);
    }

    showToast('音訊已載入', 'success');
  });

  reselectBtn.addEventListener('click', () => {
    void resetToRecordingMode();
  });

  modeSelect.addEventListener('change', () => {
    syncSourceUi();
    void persistRecordingPreferences(
      modeSelect.value as RecordingSourceMode,
      micSelect.value,
      systemSelect.value,
    );
  });

  micSelect.addEventListener('change', () => {
    void persistRecordingPreferences(
      modeSelect.value as RecordingSourceMode,
      micSelect.value,
      systemSelect.value,
    );
  });

  systemSelect.addEventListener('change', () => {
    void persistRecordingPreferences(
      modeSelect.value as RecordingSourceMode,
      micSelect.value,
      systemSelect.value,
    );
  });

  audioEl.addEventListener('loadedmetadata', () => {
    if (!state.isRecording) {
      timer.textContent = formatTime(audioEl.duration || state.previewDurationSeconds || 0);
    }
  });

  syncSourceUi();
}
