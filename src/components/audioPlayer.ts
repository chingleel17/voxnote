/**
 * 共用波形播放器元件
 * 將波形圖作為播放進度條，支援點擊 seek
 */

import { getCurrentConfig } from '../utils/configStore';

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

// 播放增益範圍：1 為原始音量，上限 4 倍（約 +12 dB）已足以補償多數會議錄音
const GAIN_MIN = 1;
const GAIN_MAX = 4;
const GAIN_DEFAULT = 2;
// 高通濾波截止頻率，與後端前處理一致
const HIGHPASS_HZ = 80;

// 輸出限幅器參數。放大後的訊號一旦超過滿刻度就會削波並產生爆音，故於鏈路末端
// 固定加上限幅器，且不隨設定關閉——動態壓縮的 attack 為毫秒等級，對突發的大聲
// 段落來不及反應，無法取代此保護。
// 實測（gain 1.6 至 4.0、含與不含動態壓縮）此組參數在各情境皆不削波且響度損失最小。
const LIMITER_THRESHOLD_DB = -6;
const LIMITER_RATIO = 20;
const LIMITER_ATTACK_SEC = 0.0002;
const LIMITER_RELEASE_SEC = 0.1;

// 播放增益的診斷記錄。增益未生效時不影響播放，但難以從畫面判斷原因，
// 故保留記錄供排查；可於主控台以 window.__voxnoteAudioDiag() 取得。
const audioDiag: string[] = [];

function recordDiag(event: string, detail: string): void {
  audioDiag.push(`[${new Date().toISOString().slice(11, 23)}] ${event}：${detail}`);
}

(window as unknown as { __voxnoteAudioDiag: () => string }).__voxnoteAudioDiag = () =>
  audioDiag.join('\n') || '（尚無記錄，請先播放一次）';

/**
 * 為跨來源的音訊來源設定 CORS 模式，必須在指定 src 之前呼叫。
 *
 * 跨來源媒體若未以 CORS 模式載入，接上 Web Audio 後會被規範要求輸出全零，
 * 且不會拋錯；同源來源（blob:）則不需要、也不應設定此屬性。
 */
export function applyMediaCrossOrigin(audioEl: HTMLAudioElement, src: string): void {
  if (src.startsWith('blob:') || src.startsWith('data:')) {
    audioEl.removeAttribute('crossorigin');
    return;
  }
  try {
    if (new URL(src, window.location.href).origin !== window.location.origin) {
      audioEl.crossOrigin = 'anonymous';
    }
  } catch {
    // 無法解析的位址不強制 CORS，交由後續的同源檢查決定是否啟用增益
  }
}

/**
 * 判斷媒體來源是否與頁面同源。
 * blob: 與 data: 由本文件產生，視為同源；無法解析的位址一律保守視為跨來源。
 */
function isSameOriginMedia(audioEl: HTMLAudioElement): boolean {
  const src = audioEl.currentSrc || audioEl.src;
  if (!src) return false;
  if (src.startsWith('blob:') || src.startsWith('data:')) return true;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** 取得設定中的播放增益，並限制在合法範圍內以免異常設定值造成削波 */
function resolveGain(): number {
  const value = getCurrentConfig()?.playback_gain;
  if (typeof value !== 'number' || !isFinite(value)) return GAIN_DEFAULT;
  return Math.min(Math.max(value, GAIN_MIN), GAIN_MAX);
}

/**
 * 播放增益控制器：延遲建立增益鏈，確保任何情況下都不會導致靜音。
 *
 * createMediaElementSource 一旦呼叫，該 audio 元素的輸出就完全交由 AudioContext
 * 接管；若此時 context 處於 suspended（WebView2 等環境在使用者手勢前的預設狀態），
 * 結果是完全沒有聲音，而非單純少了增益。因此改為在使用者實際觸發播放時才接管，
 * 且必須先確認 context 已進入 running 才串接，任何一步失敗都維持原生播放。
 */
function createGainController(audioEl: HTMLAudioElement): {
  activate: () => void;
  setGain: (value: number) => void;
  isActive: () => boolean;
} {
  let audioCtx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let pendingGain = resolveGain();
  // 建立失敗過就不再重試，避免每次播放都反覆嘗試
  let failed = false;

  /** 將節點串接完成；必須在 context 已 running 後才呼叫 */
  const connectChain = (ctx: AudioContext): void => {
    if (gainNode) return;

    // 跨來源的媒體一旦進入 createMediaElementSource，依 Web Audio 規範會輸出全零
    // （靜音）且無法還原，過程不拋任何錯誤。Tauri 的 convertFileSrc 產生的
    // asset 協定位址與 app 本身不同源，故必須先確認媒體已以 CORS 模式成功載入，
    // 否則寧可放棄增益也不能接管音訊。
    if (!isSameOriginMedia(audioEl) && audioEl.crossOrigin !== 'anonymous') {
      recordDiag('跳過增益：跨來源媒體未啟用 CORS', audioEl.currentSrc || audioEl.src);
      failed = true;
      return;
    }

    let source: MediaElementAudioSourceNode;
    try {
      // 同一個 audio 元素只能建立一次 MediaElementSource，重複呼叫會拋錯
      source = ctx.createMediaElementSource(audioEl);
    } catch (error) {
      recordDiag('createMediaElementSource 失敗', String(error));
      failed = true;
      return;
    }

    const config = getCurrentConfig();

    // 限幅器置於鏈路末端，攔截放大後可能超過滿刻度的訊號。此節點不受設定影響，
    // 是避免爆音的最後一道防線。
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_THRESHOLD_DB;
    limiter.knee.value = 0;
    limiter.ratio.value = LIMITER_RATIO;
    limiter.attack.value = LIMITER_ATTACK_SEC;
    limiter.release.value = LIMITER_RELEASE_SEC;
    limiter.connect(ctx.destination);

    const gain = ctx.createGain();
    gain.gain.value = pendingGain;
    gain.connect(limiter);

    // 依設定串接節點，未啟用者直接不接入鏈路（而非設成無作用的參數值）
    let tail: AudioNode = gain;

    if (config?.playback_compressor !== false) {
      const compressor = ctx.createDynamicsCompressor();
      // threshold 取 -28 dB：會議錄音的語音多落在此之下，可有效抬升小聲段落
      compressor.threshold.value = -28;
      compressor.knee.value = 24;
      compressor.ratio.value = 6;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      compressor.connect(tail);
      tail = compressor;
    }

    if (config?.playback_highpass !== false) {
      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = HIGHPASS_HZ;
      highpass.connect(tail);
      tail = highpass;
    }

    source.connect(tail);
    gainNode = gain;
    recordDiag(
      '增益鏈已串接',
      `gain=${gain.gain.value}, 壓縮=${config?.playback_compressor !== false}, ` +
        `高通=${config?.playback_highpass !== false}, 限幅=${LIMITER_THRESHOLD_DB}dB, ` +
        `ctx.state=${ctx.state}`,
    );
  };

  return {
    /** 於使用者播放操作時呼叫；context 未能啟動時維持原生播放 */
    activate: () => {
      if (failed || gainNode) return;

      if (!audioCtx) {
        try {
          audioCtx = new AudioContext();
          recordDiag('AudioContext 已建立', `state=${audioCtx.state}`);
        } catch (error) {
          recordDiag('AudioContext 建立失敗', String(error));
          failed = true;
          return;
        }
      }

      if (audioCtx.state === 'running') {
        connectChain(audioCtx);
        return;
      }

      // suspended 時先嘗試喚醒；resume 需在使用者手勢的呼叫堆疊中發出才會成功。
      // 未 running 前不串接，以免音訊被接管卻無法輸出而造成靜音。
      const ctx = audioCtx;
      recordDiag('context 非 running，嘗試喚醒', `state=${ctx.state}`);
      void ctx
        .resume()
        .then(() => {
          recordDiag('resume 完成', `state=${ctx.state}`);
          if (ctx.state === 'running') connectChain(ctx);
        })
        .catch((error) => {
          // 喚醒失敗則放棄增益，音訊仍由原生管道輸出
          recordDiag('resume 失敗', String(error));
        });
    },
    setGain: (value: number) => {
      pendingGain = value;
      if (!gainNode || !audioCtx) return;
      // 以 setTargetAtTime 平滑過渡，避免拖曳滑桿時產生爆音
      gainNode.gain.setTargetAtTime(value, audioCtx.currentTime, 0.01);
    },
    isActive: () => gainNode !== null,
  };
}

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

  // 播放增益控制器；實際的音訊接管延後至使用者觸發播放時
  const gainController = createGainController(audioEl);

  const gainWrap = document.createElement('div');
  gainWrap.className = 'player-gain';
  const gainSlider = document.createElement('input');
  gainSlider.type = 'range';
  gainSlider.className = 'player-gain-slider';
  gainSlider.min = String(GAIN_MIN);
  gainSlider.max = String(GAIN_MAX);
  gainSlider.step = '0.1';
  gainSlider.value = String(resolveGain());
  gainSlider.title = '播放增益';
  const gainLabel = document.createElement('span');
  gainLabel.className = 'player-gain-label';
  gainLabel.textContent = `${Number(gainSlider.value).toFixed(1)}x`;
  gainSlider.addEventListener('input', () => {
    const value = Number(gainSlider.value);
    gainLabel.textContent = `${value.toFixed(1)}x`;
    gainController.setGain(value);
  });
  gainWrap.appendChild(gainSlider);
  gainWrap.appendChild(gainLabel);

  // 增益鏈僅在使用者播放後才建立，若環境不允許則維持原生播放。
  // 標籤直接顯示實際狀態，避免滑桿看似可調整但其實未生效。
  const syncGainState = (): void => {
    const active = gainController.isActive();
    const value = Number(gainSlider.value);
    gainWrap.classList.toggle('inactive', !active);
    if (active) {
      gainLabel.textContent = `${value.toFixed(1)}x`;
      gainSlider.title = '播放增益';
    } else {
      // 未生效時明確標示，而非顯示一個沒有作用的倍率
      gainLabel.textContent = audioEl.paused ? `${value.toFixed(1)}x` : '未生效';
      gainSlider.title = '播放增益（此環境不支援，音訊以原始音量播放）';
    }
  };
  syncGainState();

  container.appendChild(playBtn);
  container.appendChild(currentTimeEl);
  container.appendChild(canvas);
  container.appendChild(durationEl);
  container.appendChild(volumeBtn);
  container.appendChild(gainWrap);

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
    // 逐字稿時間戳等來源會直接呼叫 audioEl.play() 而未經播放鈕，於此補上啟用。
    // 該路徑源自使用者點擊，通常仍在手勢的有效期間內；即使喚醒失敗，控制器也只是
    // 維持不接管，音訊仍由原生管道輸出。
    gainController.activate();
    // resume 為非同步，稍候再同步狀態顯示
    window.setTimeout(syncGainState, 100);
    playBtn.innerHTML = ICON_PAUSE;
    document.querySelectorAll<HTMLAudioElement>('audio').forEach((other) => {
      if (other !== audioEl && !other.paused) other.pause();
    });
  });
  audioEl.addEventListener('pause', () => {
    playBtn.innerHTML = ICON_PLAY;
  });

  playBtn.addEventListener('click', () => {
    if (audioEl.paused) {
      // 必須在使用者手勢的同步流程中啟用，AudioContext 才允許自 suspended 喚醒
      gainController.activate();
      void audioEl.play();
    } else {
      audioEl.pause();
    }
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
