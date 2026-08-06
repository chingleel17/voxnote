/**
 * 共用波形播放器元件
 * 將波形圖作為播放進度條，支援點擊 seek
 */

const ICON_PLAY = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_PAUSE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
const ICON_VOL_ON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>`;
const ICON_VOL_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;

function formatPlayerTime(secs: number): string {
  if (!isFinite(secs) || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const NUM_BARS = 300;
const BAR_COLOR_PLAYED = '#6366f1';
const BAR_COLOR_UNPLAYED = '#2e3048';
// 大於此門檻的音訊檔不進行整檔波形解碼，避免長錄音把 webview 記憶體撐爆
const WAVEFORM_DECODE_SIZE_LIMIT = 100 * 1024 * 1024; // 100MB
const WAVEFORM_DECODE_DURATION_LIMIT = 60 * 60; // 60 分鐘
const PLAYHEAD_COLOR = 'rgba(255,255,255,0.85)';
const CANVAS_HEIGHT = 56;

/**
 * 建立波形播放器，接受已設定 src 的 audio 元素
 * 播放器會非同步解碼音訊並繪製波形
 */
export function createWaveformPlayer(audioEl: HTMLAudioElement): HTMLElement {
  const container = document.createElement('div');
  container.className = 'custom-player';

  const playBtn = document.createElement('button');
  playBtn.className = 'player-play-btn';
  playBtn.innerHTML = ICON_PLAY;

  const currentTimeEl = document.createElement('span');
  currentTimeEl.className = 'player-time';
  currentTimeEl.textContent = '0:00';

  const canvas = document.createElement('canvas');
  canvas.className = 'player-waveform';
  canvas.style.height = `${CANVAS_HEIGHT}px`;

  const durationEl = document.createElement('span');
  durationEl.className = 'player-time';
  durationEl.textContent = '0:00';

  const volumeBtn = document.createElement('button');
  volumeBtn.className = 'player-volume-btn';
  volumeBtn.innerHTML = ICON_VOL_ON;

  container.appendChild(playBtn);
  container.appendChild(currentTimeEl);
  container.appendChild(canvas);
  container.appendChild(durationEl);
  container.appendChild(volumeBtn);

  let peaks: Float32Array | null = null;

  function drawCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.getBoundingClientRect().width || 300;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(CANVAS_HEIGHT * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = cssWidth;
    const h = CANVAS_HEIGHT;
    const progress = audioEl.duration > 0 ? audioEl.currentTime / audioEl.duration : 0;
    const playheadX = progress * w;

    ctx.clearRect(0, 0, w, h);

    if (peaks) {
      const barW = w / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const x = i * barW;
        const barH = Math.max(peaks[i] * h * 0.85, 2);
        const y = (h - barH) / 2;
        ctx.fillStyle = x < playheadX ? BAR_COLOR_PLAYED : BAR_COLOR_UNPLAYED;
        ctx.fillRect(x, y, Math.max(barW - 1, 1), barH);
      }
    } else {
      // 波形尚未解碼時顯示簡易進度條
      ctx.fillStyle = BAR_COLOR_UNPLAYED;
      ctx.fillRect(0, h / 2 - 2, w, 4);
      if (playheadX > 0) {
        ctx.fillStyle = BAR_COLOR_PLAYED;
        ctx.fillRect(0, h / 2 - 2, playheadX, 4);
      }
    }

    // 播放頭垂直線
    if (audioEl.duration > 0 && playheadX > 0) {
      ctx.strokeStyle = PLAYHEAD_COLOR;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 4);
      ctx.lineTo(playheadX, h - 4);
      ctx.stroke();
    }
  }

  async function decodeWaveform(): Promise<void> {
    const src = audioEl.src;
    if (!src) return;
    if (audioEl.duration > WAVEFORM_DECODE_DURATION_LIMIT) {
      drawCanvas();
      return;
    }
    try {
      const resp = await fetch(src);
      const contentLength = resp.headers.get('content-length');
      if (contentLength && Number(contentLength) > WAVEFORM_DECODE_SIZE_LIMIT) {
        drawCanvas();
        return;
      }
      const buffer = await resp.arrayBuffer();
      const audioCtx = new AudioContext();
      const decoded = await audioCtx.decodeAudioData(buffer);
      const channelData = decoded.getChannelData(0);
      const step = Math.ceil(channelData.length / NUM_BARS);
      peaks = new Float32Array(NUM_BARS);
      for (let i = 0; i < NUM_BARS; i++) {
        let max = 0;
        for (let j = 0; j < step; j++) {
          const sample = Math.abs(channelData[i * step + j] ?? 0);
          if (sample > max) max = sample;
        }
        peaks[i] = max;
      }
      await audioCtx.close();
      drawCanvas();
    } catch {
      // 解碼失敗則維持進度條顯示
      drawCanvas();
    }
  }

  audioEl.addEventListener('loadedmetadata', () => {
    durationEl.textContent = formatPlayerTime(audioEl.duration);
    currentTimeEl.textContent = '0:00';
    drawCanvas();
    void decodeWaveform();
  });

  audioEl.addEventListener('timeupdate', () => {
    currentTimeEl.textContent = formatPlayerTime(audioEl.currentTime);
    drawCanvas();
  });

  audioEl.addEventListener('ended', () => {
    playBtn.innerHTML = ICON_PLAY;
    currentTimeEl.textContent = formatPlayerTime(audioEl.duration);
  });

  audioEl.addEventListener('play', () => {
    playBtn.innerHTML = ICON_PAUSE;
    document.querySelectorAll<HTMLAudioElement>('audio').forEach((other) => {
      if (other !== audioEl && !other.paused) other.pause();
    });
  });
  audioEl.addEventListener('pause', () => {
    playBtn.innerHTML = ICON_PLAY;
  });

  playBtn.addEventListener('click', () => {
    if (audioEl.paused) void audioEl.play();
    else audioEl.pause();
  });

  canvas.addEventListener('click', (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (audioEl.duration > 0) {
      audioEl.currentTime = ((e.clientX - rect.left) / rect.width) * audioEl.duration;
      drawCanvas();
    }
  });

  let muted = false;
  volumeBtn.addEventListener('click', () => {
    muted = !muted;
    audioEl.muted = muted;
    volumeBtn.innerHTML = muted ? ICON_VOL_OFF : ICON_VOL_ON;
  });

  const ro = new ResizeObserver(() => drawCanvas());
  ro.observe(canvas);

  // 若 audio 已有 src 且 duration 已知（例如重新插入 DOM），立即繪製
  if (audioEl.readyState >= HTMLMediaElement.HAVE_METADATA) {
    durationEl.textContent = formatPlayerTime(audioEl.duration);
    requestAnimationFrame(() => {
      drawCanvas();
      void decodeWaveform();
    });
  } else {
    requestAnimationFrame(drawCanvas);
  }

  return container;
}
