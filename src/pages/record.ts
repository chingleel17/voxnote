import type { Category, MeetingWithDetails, SavedParticipant, Tag } from '../types';
import { createMeeting, getCategories, getMeetings } from '../api/meetings';
import { writeRecordingFile } from '../api/recordings';
import { getSavedParticipants, upsertSavedParticipant } from '../api/participants';
import { getTags } from '../api/tags';
import { openModal } from '../components/modal';
import { showToast } from '../components/toast';
import { createWaveformPlayer } from '../components/audioPlayer';
import { buildParticipantEditor } from '../components/participantEditor';

interface RecordingState {
  mediaRecorder: MediaRecorder | null;
  audioChunks: Blob[];
  stream: MediaStream | null;
  startTime: number;
  timerInterval: number | null;
  audioBlob: Blob | null;
  audioBlobUrl: string | null;
  uploadedFile: File | null;
  analyser: AnalyserNode | null;
  animationId: number | null;
}

const state: RecordingState = {
  mediaRecorder: null,
  audioChunks: [],
  stream: null,
  startTime: 0,
  timerInterval: null,
  audioBlob: null,
  audioBlobUrl: null,
  uploadedFile: null,
  analyser: null,
  animationId: null,
};

function stopAll(): void {
  if (state.timerInterval !== null) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.animationId !== null) {
    cancelAnimationFrame(state.animationId);
    state.animationId = null;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  if (state.audioBlobUrl) {
    URL.revokeObjectURL(state.audioBlobUrl);
    state.audioBlobUrl = null;
  }
  state.audioBlob = null;
  state.uploadedFile = null;
}

function drawWaveform(canvas: HTMLCanvasElement, analyser: AnalyserNode): void {
  const ctxOrNull = canvas.getContext('2d');
  if (!ctxOrNull) return;
  const ctx: CanvasRenderingContext2D = ctxOrNull;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw(): void {
    state.animationId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(dataArray);

    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#6366f1';
    ctx.beginPath();

    const sliceWidth = canvas.width / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const v = (dataArray[i] ?? 128) / 128.0;
      const y = (v * canvas.height) / 2;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }

  draw();
}

/** 從 AudioBuffer 降採樣後繪製靜態波形 */
function drawStaticWaveform(canvas: HTMLCanvasElement, audioBuffer: AudioBuffer): void {
  const ctxOrNull = canvas.getContext('2d');
  if (!ctxOrNull) return;
  const ctx = ctxOrNull;

  const channelData = audioBuffer.getChannelData(0);
  const step = Math.ceil(channelData.length / canvas.width);

  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
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

function formatTime(secs: number): string {
  if (!isFinite(secs) || isNaN(secs)) return '0:00';
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

export async function renderRecordPage(container: HTMLElement, preselectedMeetingId?: string): Promise<void> {
  stopAll();
  container.innerHTML = '';

  let meetings: MeetingWithDetails[] = [];
  let categories: Category[] = [];
  let savedParticipants: SavedParticipant[] = [];
  let allTags: Tag[] = [];
  try {
    [meetings, categories, savedParticipants, allTags] = await Promise.all([
      getMeetings(),
      getCategories(),
      getSavedParticipants(),
      getTags(),
    ]);
  } catch {
    // 允許在沒有會議時繼續使用錄音頁
  }

  // 頁面標題
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

  // 會議選擇
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
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Node)) return;
    if (!meetingSearchRow.contains(event.target)) {
      setMeetingDropdownOpen(false);
    }
  });
  meetingGroup.appendChild(meetingLabel);
  meetingGroup.appendChild(meetingSearchRow);
  wrapper.appendChild(meetingGroup);

  // 自動選取預設會議
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

  // 麥克風選擇
  const micGroup = document.createElement('div');
  micGroup.className = 'form-group';
  const micLabel = document.createElement('label');
  micLabel.textContent = '麥克風';
  const micSelect = document.createElement('select');
  micSelect.className = 'form-control';

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter((d) => d.kind === 'audioinput');
    for (const device of audioInputs) {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `麥克風 ${device.deviceId.slice(0, 8)}`;
      micSelect.appendChild(opt);
    }
  } catch {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '預設麥克風';
    micSelect.appendChild(opt);
  }
  micGroup.appendChild(micLabel);
  micGroup.appendChild(micSelect);
  wrapper.appendChild(micGroup);

  // 波形視覺化
  const canvas = document.createElement('canvas');
  canvas.className = 'waveform-canvas';
  canvas.width = 600;
  canvas.height = 100;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  wrapper.appendChild(canvas);

  // 計時器
  const timer = document.createElement('div');
  timer.className = 'record-timer';
  timer.textContent = '00:00';
  wrapper.appendChild(timer);

  // 錄音控制按鈕
  const controlRow = document.createElement('div');
  controlRow.className = 'record-controls';

  const recordBtn = document.createElement('button');
  recordBtn.className = 'btn btn-record';
  recordBtn.textContent = '開始錄音';

  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'btn btn-secondary';
  uploadBtn.textContent = '上傳音訊';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'audio/*';
  fileInput.style.display = 'none';

  const reselectBtn = document.createElement('button');
  reselectBtn.className = 'btn btn-ghost hidden';
  reselectBtn.textContent = '重新選擇';

  controlRow.appendChild(recordBtn);
  controlRow.appendChild(uploadBtn);
  controlRow.appendChild(reselectBtn);
  controlRow.appendChild(fileInput);
  wrapper.appendChild(controlRow);

  // 播放器區塊（錄音完成後顯示）
  const playerSection = document.createElement('div');
  playerSection.className = 'record-player hidden';
  const playerTitle = document.createElement('p');
  playerTitle.className = 'player-hint';
  playerTitle.textContent = '錄音完成，請確認後儲存：';

  const audioEl = document.createElement('audio');
  audioEl.preload = 'metadata';
  audioEl.style.display = 'none';
  let customPlayerEl = createWaveformPlayer(audioEl);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = '儲存錄音';

  playerSection.appendChild(playerTitle);
  playerSection.appendChild(audioEl);
  playerSection.appendChild(customPlayerEl);
  playerSection.appendChild(saveBtn);
  wrapper.appendChild(playerSection);

  // 錄音邏輯
  let isRecording = false;

  recordBtn.addEventListener('click', async () => {
    if (!isRecording) {
      await startRecording();
    } else {
      stopRecording();
    }
  });

  async function startRecording(): Promise<void> {
    const deviceId = micSelect.value;
    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    };

    try {
      state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      showToast(`無法存取麥克風：${String(err)}`, 'error');
      return;
    }

    // 波形分析
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(state.stream);
    state.analyser = audioCtx.createAnalyser();
    state.analyser.fftSize = 2048;
    source.connect(state.analyser);
    drawWaveform(canvas, state.analyser);

    state.mediaRecorder = new MediaRecorder(state.stream);
    state.audioChunks = [];

    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.audioChunks.push(e.data);
    };

    state.mediaRecorder.onstop = () => {
      state.audioBlob = new Blob(state.audioChunks, { type: 'audio/webm' });
      state.audioBlobUrl = URL.createObjectURL(state.audioBlob);
      audioEl.src = state.audioBlobUrl;
      playerSection.classList.remove('hidden');
    };

    state.mediaRecorder.start();
    isRecording = true;
    state.startTime = Date.now();
    recordBtn.textContent = '停止錄音';
    recordBtn.classList.add('recording');

    state.timerInterval = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      timer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, 1000);
  }

  function stopRecording(): void {
    state.mediaRecorder?.stop();
    isRecording = false;
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
  }

  saveBtn.addEventListener('click', async () => {
    const meetingId = selectedMeetingId;
    if (!meetingId) {
      showToast('請先選擇會議', 'warning');
      return;
    }
    if (!state.audioBlobUrl) {
      showToast('尚無錄音檔案', 'warning');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = '儲存中…';

    try {
      // 計算時長：錄音模式有 startTime，上傳模式取 null
      const durationSeconds =
        state.audioBlob && state.startTime > 0
          ? Math.floor((Date.now() - state.startTime) / 1000)
          : null;

      // 取得副檔名
      const ext = state.uploadedFile
        ? (state.uploadedFile.name.split('.').pop() ?? 'webm')
        : 'webm';
      const fileName = `${meetingId}_${Date.now()}.${ext}`;

      // 讀取音訊 bytes 交由後端寫入設定的錄音資料夾
      const response = await fetch(state.audioBlobUrl);
      const buffer = await response.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buffer));

      await writeRecordingFile(meetingId, bytes, fileName, state.uploadedFile?.name ?? null, durationSeconds);
      showToast('錄音已儲存', 'success');
      window.location.hash = `#meeting/${meetingId}`;
    } catch (err) {
      showToast(`儲存失敗：${String(err)}`, 'error');
      saveBtn.disabled = false;
      saveBtn.textContent = '儲存錄音';
    }
  });

  // 上傳音訊
  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    if (state.audioBlobUrl) URL.revokeObjectURL(state.audioBlobUrl);
    state.audioBlobUrl = URL.createObjectURL(file);
    state.uploadedFile = file;
    state.audioBlob = null;
    state.startTime = 0;

    // 切換控制區：隱藏錄音按鈕，顯示重新選擇
    recordBtn.classList.add('hidden');
    micGroup.classList.add('hidden');
    reselectBtn.classList.remove('hidden');

    // 設定音訊來源並顯示播放器
    audioEl.src = state.audioBlobUrl;
    playerSection.classList.remove('hidden');
    playerTitle.textContent = `已載入音訊（${file.name}），請確認後儲存：`;

    // Timer 顯示音訊時長
    audioEl.addEventListener('loadedmetadata', () => {
      timer.textContent = formatTime(audioEl.duration);
    }, { once: true });

    // 停止錄音動態波形
    if (state.animationId !== null) {
      cancelAnimationFrame(state.animationId);
      state.animationId = null;
    }

    // 波形分析中提示
    const waveCtx = canvas.getContext('2d');
    if (waveCtx) {
      waveCtx.fillStyle = '#0f1117';
      waveCtx.fillRect(0, 0, canvas.width, canvas.height);
      waveCtx.fillStyle = '#6366f1';
      waveCtx.font = '14px sans-serif';
      waveCtx.textAlign = 'center';
      waveCtx.fillText('波形分析中…', canvas.width / 2, canvas.height / 2 + 5);
    }

    // 繪製靜態波形（非同步，不阻塞 UI）
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new AudioContext();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      drawStaticWaveform(canvas, audioBuffer);
      await audioCtx.close();
    } catch {
      const c = canvas.getContext('2d');
      if (c) {
        c.fillStyle = '#0f1117';
        c.fillRect(0, 0, canvas.width, canvas.height);
      }
    }

    showToast('音訊已載入', 'success');
  });

  // 重新選擇：恢復錄音控制
  reselectBtn.addEventListener('click', () => {
    reselectBtn.classList.add('hidden');
    recordBtn.classList.remove('hidden');
    micGroup.classList.remove('hidden');
    playerSection.classList.add('hidden');
    timer.textContent = '00:00';
    if (state.audioBlobUrl) {
      URL.revokeObjectURL(state.audioBlobUrl);
      state.audioBlobUrl = null;
    }
    state.uploadedFile = null;
    audioEl.src = '';
    const c = canvas.getContext('2d');
    if (c) {
      c.fillStyle = '#0f1117';
      c.fillRect(0, 0, canvas.width, canvas.height);
    }
    fileInput.value = '';
  });
}
