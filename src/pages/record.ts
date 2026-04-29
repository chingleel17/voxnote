import type { MeetingWithDetails } from '../types';
import { getMeetings } from '../api/meetings';
import { saveRecording } from '../api/recordings';
import { showToast } from '../components/toast';

interface RecordingState {
  mediaRecorder: MediaRecorder | null;
  audioChunks: Blob[];
  stream: MediaStream | null;
  startTime: number;
  timerInterval: number | null;
  audioBlob: Blob | null;
  audioBlobUrl: string | null;
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

  controlRow.appendChild(recordBtn);
  controlRow.appendChild(uploadBtn);
  controlRow.appendChild(fileInput);
  wrapper.appendChild(controlRow);

  // 播放器區塊（錄音完成後顯示）
  const playerSection = document.createElement('div');
  playerSection.className = 'record-player hidden';
  const playerTitle = document.createElement('p');
  playerTitle.className = 'player-hint';
  playerTitle.textContent = '錄音完成，請確認後儲存：';
  const audioPlayer = document.createElement('audio');
  audioPlayer.controls = true;
  audioPlayer.className = 'audio-player';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = '儲存錄音';

  playerSection.appendChild(playerTitle);
  playerSection.appendChild(audioPlayer);
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
      audioPlayer.src = state.audioBlobUrl;
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
    const elapsed = Math.floor((Date.now() - state.startTime) / 1000);
    try {
      await saveRecording(meetingId, state.audioBlobUrl, elapsed > 0 ? elapsed : null);
      showToast('錄音已儲存，請前往會議詳情確認', 'success');
      window.location.hash = `#meeting/${meetingId}`;
    } catch (err) {
      showToast(`儲存失敗：${String(err)}`, 'error');
    }
  });

  // 上傳音訊
  uploadBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (state.audioBlobUrl) URL.revokeObjectURL(state.audioBlobUrl);
    state.audioBlobUrl = URL.createObjectURL(file);
    audioPlayer.src = state.audioBlobUrl;
    playerSection.classList.remove('hidden');
    showToast('音訊已載入', 'success');
  });
}
