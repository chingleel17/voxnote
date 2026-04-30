import type { MeetingWithDetails } from '../types';
import { getMeetings } from '../api/meetings';
import { writeRecordingFile } from '../api/recordings';
import { showToast } from '../components/toast';

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

const ICON_PLAY = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_PAUSE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
const ICON_VOL_ON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>`;
const ICON_VOL_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;

function buildCustomPlayer(audioEl: HTMLAudioElement): HTMLElement {
  const playerEl = document.createElement('div');
  playerEl.className = 'custom-player';

  const playBtn = document.createElement('button');
  playBtn.className = 'player-play-btn';
  playBtn.innerHTML = ICON_PLAY;

  const currentTimeEl = document.createElement('span');
  currentTimeEl.className = 'player-time';
  currentTimeEl.textContent = '0:00';

  const progressBar = document.createElement('div');
  progressBar.className = 'player-progress';
  const progressFill = document.createElement('div');
  progressFill.className = 'player-progress-fill';
  progressBar.appendChild(progressFill);

  const durationEl = document.createElement('span');
  durationEl.className = 'player-time';
  durationEl.textContent = '0:00';

  const volumeBtn = document.createElement('button');
  volumeBtn.className = 'player-volume-btn';
  volumeBtn.innerHTML = ICON_VOL_ON;

  playerEl.appendChild(playBtn);
  playerEl.appendChild(currentTimeEl);
  playerEl.appendChild(progressBar);
  playerEl.appendChild(durationEl);
  playerEl.appendChild(volumeBtn);

  playBtn.addEventListener('click', () => {
    if (audioEl.paused) void audioEl.play();
    else audioEl.pause();
  });

  audioEl.addEventListener('play', () => { playBtn.innerHTML = ICON_PAUSE; });
  audioEl.addEventListener('pause', () => { playBtn.innerHTML = ICON_PLAY; });
  audioEl.addEventListener('ended', () => {
    playBtn.innerHTML = ICON_PLAY;
    progressFill.style.width = '0%';
    currentTimeEl.textContent = '0:00';
  });

  audioEl.addEventListener('loadedmetadata', () => {
    durationEl.textContent = formatTime(audioEl.duration);
    currentTimeEl.textContent = '0:00';
    progressFill.style.width = '0%';
  });

  audioEl.addEventListener('timeupdate', () => {
    currentTimeEl.textContent = formatTime(audioEl.currentTime);
    if (audioEl.duration) {
      progressFill.style.width = `${(audioEl.currentTime / audioEl.duration) * 100}%`;
    }
  });

  progressBar.addEventListener('click', (e: MouseEvent) => {
    const rect = progressBar.getBoundingClientRect();
    if (audioEl.duration) {
      audioEl.currentTime = ((e.clientX - rect.left) / rect.width) * audioEl.duration;
    }
  });

  let muted = false;
  volumeBtn.addEventListener('click', () => {
    muted = !muted;
    audioEl.muted = muted;
    volumeBtn.innerHTML = muted ? ICON_VOL_OFF : ICON_VOL_ON;
  });

  return playerEl;
}

export async function renderRecordPage(container: HTMLElement): Promise<void> {
  stopAll();
  container.innerHTML = '';

  let meetings: MeetingWithDetails[] = [];
  try {
    meetings = await getMeetings();
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
  const meetingSelect = document.createElement('select');
  meetingSelect.className = 'form-control';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '-- 請選擇會議 --';
  meetingSelect.appendChild(noneOpt);
  for (const m of meetings) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.title;
    meetingSelect.appendChild(opt);
  }
  meetingGroup.appendChild(meetingLabel);
  meetingGroup.appendChild(meetingSelect);
  wrapper.appendChild(meetingGroup);

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
  const customPlayerEl = buildCustomPlayer(audioEl);

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
    const meetingId = meetingSelect.value;
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

      // 讀取音訊位元組
      const response = await fetch(state.audioBlobUrl);
      const buffer = await response.arrayBuffer();
      const fileData = Array.from(new Uint8Array(buffer));

      await writeRecordingFile(meetingId, fileData, fileName, durationSeconds);
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
    playerTitle.textContent = '已載入音訊，請確認後儲存：';

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
