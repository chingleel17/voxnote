use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use anyhow::{anyhow, Context, Result};
use cpal::traits::StreamTrait;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::{
    ai::call_llm,
    asr::transcribe_live_caption_remote,
    audio_recording::{
        self, DesktopRecordingManager, RecordingDeviceList, SharedError, SharedQueue,
    },
    commands::ai_cmds::PROOFREAD_CORE_SYSTEM,
    config::AppConfig,
};

mod agreement;
use agreement::LocalAgreement;

pub const LIVE_CAPTION_EVENT: &str = "live-caption";
pub const LIVE_CAPTION_ERROR_EVENT: &str = "live-caption-error";
pub const LIVE_CAPTION_STATUS_EVENT: &str = "live-caption-status";
pub const LIVE_CAPTION_SETTINGS_EVENT: &str = "live-caption-settings";
pub const LIVE_CAPTION_OVERLAY_LABEL: &str = "live-caption-overlay";
pub const LIVE_CAPTION_INTERACTIVE_EVENT: &str = "live-caption-interactive";
/// 點擊穿透的游標輪詢間隔；過長會讓邊框反應遲鈍，過短則徒增 CPU 負擔。
const CLICK_THROUGH_POLL_INTERVAL: Duration = Duration::from_millis(80);
/// 視窗邊框的互動感應寬度（邏輯像素），與前端 CSS 的邊框判定一致。
const OVERLAY_EDGE_ZONE_LOGICAL: f64 = 10.0;
/// 標題列感應高度（邏輯像素），游標位於此範圍內恢復互動以便拖曳、鎖定與關閉。
/// 需涵蓋 CSS 的上內距（10px）加標題列本身（min-height 20px），故略大於兩者之和。
const OVERLAY_HEADER_HEIGHT_LOGICAL: f64 = 34.0;
const SAMPLE_RATE: u32 = 16_000;
const CAPTURE_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// 增量字幕的顯示段落週期；與 ASR 解碼間隔刻意分離。
const DISPLAY_SEGMENT_DURATION: Duration = Duration::from_secs(4);
/// 逐段的非語音機率上限，超過即視為模型在近乎無語音的片段上硬吐文字。
/// 取 0.6 而非更嚴的值，是因為即時字幕的短視窗本就容易讓此機率偏高。
/// 注意：實測顯示幻覺片段的此機率為 0.000，故此項對該類幻覺無攔截效果。
const SEGMENT_NO_SPEECH_MAX: f32 = 0.6;
/// 字幕視窗的預設高度（邏輯像素），約可容納兩行文字（預設字級 28px、
/// line-height 1.25 → 35px／行）加上標題列與內距。使用者仍可自行拖曳調整，
/// 此值僅為每次啟動時的初始高度。
const OVERLAY_DEFAULT_HEIGHT_LOGICAL: f64 = 130.0;
const OVERLAY_DEFAULT_WIDTH_LOGICAL: f64 = 720.0;
/// 待處理音訊佇列的上限（秒）。轉錄落後擷取時（遠端逾時、負載過高），
/// 佇列會持續累積；超過此上限即丟棄最舊樣本，讓字幕追上當下聲音而非
/// 越積越舊、記憶體無限成長。取視窗長度的數倍，容許短暫落後但不無限等待。
const MAX_PENDING_AUDIO_SECONDS: usize = 30;
/// 丟棄提示的節流間隔：持續落後時避免每次丟棄都洗版錯誤事件通道。
const DROP_NOTICE_THROTTLE: Duration = Duration::from_secs(10);
/// 預設垂直位置：螢幕下方三分之一處（視窗頂部離螢幕底部的距離為螢幕高度的
/// 1/3，而非視窗頂部緊貼該線），對應常見影片字幕的視覺位置。
/// 字幕字級的四檔預設值（S/M/L/XL，單位為像素）。使用者只能由此四檔中選擇，
/// 不開放輸入任意數字；同時顯示的行數已改由視窗高度與此字級計算，故字級的
/// 級距不宜過密，否則行數估算會過於敏感。
const FONT_SIZE_PRESETS: [u32; 4] = [20, 24, 28, 36];

/// 將任意字級數值收斂至最接近的預設檔位，用於既有 config.toml 內非四檔之一的
/// 舊數值（例如使用者曾以進階設定輸入的任意 px）。
fn nearest_font_size_preset(value: u32) -> u32 {
    FONT_SIZE_PRESETS
        .iter()
        .copied()
        .min_by_key(|preset| preset.abs_diff(value))
        .unwrap_or(28)
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartLiveCaptionRequest {
    pub audio_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveCaptionPayload {
    pub sequence: u64,
    pub original: String,
    pub translation: Option<String>,
    pub display_text: String,
    pub confirmed_text: String,
    pub tentative_text: String,
    pub is_tentative: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveCaptionErrorPayload {
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveCaptionStatus {
    pub active: bool,
    pub backend: Option<String>,
    pub audio_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveCaptionSettingsPayload {
    pub font_size: u32,
    pub clear_seconds: u32,
    pub click_through: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveCaptionBuildInfo {
    pub cuda_enabled: bool,
}

#[derive(Debug, Default)]
struct IncrementalSegmentState {
    sequence: Option<u64>,
    started_at: Option<Instant>,
    text: String,
    committed_sample_offset: usize,
}

impl IncrementalSegmentState {
    fn is_expired(&self) -> bool {
        self.started_at
            .is_some_and(|started| started.elapsed() >= DISPLAY_SEGMENT_DURATION)
    }

    #[cfg(test)]
    fn is_expired_at(&self, now: Instant) -> bool {
        self.started_at
            .is_some_and(|started| now.duration_since(started) >= DISPLAY_SEGMENT_DURATION)
    }

    fn start(&mut self, sequence: u64) {
        self.sequence = Some(sequence);
        self.started_at = Some(Instant::now());
    }

    fn complete(&mut self, captured_sample_offset: usize) -> Option<(u64, String)> {
        let sequence = self.sequence.take()?;
        let text = std::mem::take(&mut self.text);
        self.started_at = None;
        self.committed_sample_offset = captured_sample_offset;
        Some((sequence, text))
    }
}

#[derive(Default)]
pub struct LiveCaptionManager {
    inner: Mutex<Option<ActiveLiveCaptionSession>>,
}

struct ActiveLiveCaptionSession {
    stop_tx: mpsc::Sender<()>,
    running: Arc<AtomicBool>,
    handle: thread::JoinHandle<()>,
    backend: String,
    audio_source: String,
    // 「鎖定」＝穿透模式是否開啟。開啟時字幕視窗預設穿透（不可拖曳／調整大小），
    // 但游標移到標題列或邊框感應區時仍由 watcher 動態恢復互動，供關閉鈕、拖曳與調整大小使用；
    // 關閉時視窗恆為可互動，不穿透。由主控制面板的鎖定按鈕切換此旗標。
    click_through_enabled: Arc<AtomicBool>,
}

impl LiveCaptionManager {
    pub fn start(
        &self,
        app: &AppHandle,
        recording_manager: &DesktopRecordingManager,
        config: AppConfig,
        request: Option<StartLiveCaptionRequest>,
    ) -> Result<()> {
        if audio_recording::is_recording(recording_manager) {
            return Err(anyhow!("目前有桌面錄音進行中，無法啟動即時字幕"));
        }

        let audio_source = request
            .and_then(|request| request.audio_source)
            .unwrap_or_else(|| config.live_caption_audio_source.clone());
        validate_audio_source(&audio_source)?;
        validate_caption_window(&config)?;

        let backend = normalize_backend(&config.live_caption_backend)?;
        if backend == "local_whisper" {
            let model_path = config.live_caption_model_path.trim();
            if model_path.is_empty() {
                return Err(anyhow!("尚未設定即時字幕的 GGML 模型檔路徑"));
            }
            if !std::path::Path::new(model_path).is_file() {
                return Err(anyhow!("即時字幕模型檔不存在：{}", model_path));
            }
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("無法取得即時字幕狀態"))?;
        if let Some(session) = guard.as_ref() {
            if session.running.load(Ordering::SeqCst) {
                return Err(anyhow!("已有即時字幕進行中"));
            }
            let finished = guard.take();
            drop(guard);
            if let Some(session) = finished {
                let _ = session.handle.join();
            }
            guard = self
                .inner
                .lock()
                .map_err(|_| anyhow!("無法取得即時字幕狀態"))?;
        }

        let queue: SharedQueue = Arc::new(Mutex::new(VecDeque::new()));
        let error_state: SharedError = Arc::new(Mutex::new(None));
        let running = Arc::new(AtomicBool::new(true));
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let app_handle = app.clone();
        let thread_config = config.clone();
        let thread_source = audio_source.clone();
        let thread_backend = backend.clone();
        let thread_running = running.clone();
        let thread_queue = queue.clone();
        let thread_error = error_state.clone();
        let startup_tx = ready_tx.clone();
        let error_app = app_handle.clone();

        let handle = thread::spawn(move || {
            let result = run_live_caption_session(
                app_handle,
                thread_config,
                thread_backend,
                thread_source,
                thread_queue,
                thread_error,
                thread_running.clone(),
                stop_rx,
                ready_tx,
            );
            thread_running.store(false, Ordering::SeqCst);
            if let Err(error) = result {
                let _ = startup_tx.send(Err(anyhow!(error.to_string())));
                emit_error(&error_app, error.to_string());
            }
        });

        match ready_rx.recv() {
            Ok(Ok(())) => {
                let overlay = match app.get_webview_window(LIVE_CAPTION_OVERLAY_LABEL) {
                    Some(overlay) => overlay,
                    None => {
                        running.store(false, Ordering::SeqCst);
                        let _ = stop_tx.send(());
                        let _ = handle.join();
                        return Err(anyhow!("找不到即時字幕浮動視窗"));
                    }
                };
                if let Err(error) = overlay.show() {
                    running.store(false, Ordering::SeqCst);
                    let _ = stop_tx.send(());
                    let _ = handle.join();
                    return Err(anyhow!("無法開啟即時字幕浮動視窗：{error}"));
                }
                if let Err(error) = overlay.set_always_on_top(true) {
                    running.store(false, Ordering::SeqCst);
                    let _ = stop_tx.send(());
                    let _ = handle.join();
                    let _ = overlay.hide();
                    return Err(anyhow!("無法將即時字幕視窗設為最上層：{error}"));
                }
                // 每次啟動皆套用預設大小與位置：目前無位置持久化機制，
                // 沿用既有行為（每次開啟皆回到固定初始狀態）。失敗僅記錄，
                // 不影響字幕啟動——大小／位置本就可由使用者手動調整。
                apply_default_overlay_geometry(&overlay);
                let _ = app.emit(
                    LIVE_CAPTION_SETTINGS_EVENT,
                    LiveCaptionSettingsPayload {
                        font_size: nearest_font_size_preset(config.live_caption_font_size),
                        clear_seconds: config.live_caption_clear_seconds.min(60),
                        click_through: config.live_caption_click_through,
                    },
                );
                let click_through_enabled =
                    Arc::new(AtomicBool::new(config.live_caption_click_through));
                let _ = overlay.set_ignore_cursor_events(config.live_caption_click_through);
                // watcher 全程運作：鎖定關閉時強制維持可互動，鎖定開啟時依游標位置動態切換。
                spawn_click_through_watcher(
                    app.clone(),
                    running.clone(),
                    click_through_enabled.clone(),
                );
                let _ = app.emit(
                    LIVE_CAPTION_STATUS_EVENT,
                    LiveCaptionStatus {
                        active: true,
                        backend: Some(backend.clone()),
                        audio_source: Some(audio_source.clone()),
                    },
                );
                *guard = Some(ActiveLiveCaptionSession {
                    stop_tx,
                    running,
                    handle,
                    backend,
                    audio_source,
                    click_through_enabled,
                });
                Ok(())
            }
            Ok(Err(error)) => {
                running.store(false, Ordering::SeqCst);
                let _ = stop_tx.send(());
                let _ = handle.join();
                Err(error)
            }
            Err(_) => {
                running.store(false, Ordering::SeqCst);
                let _ = stop_tx.send(());
                let _ = handle.join();
                Err(anyhow!("即時字幕啟動執行緒未回報結果"))
            }
        }
    }

    pub fn stop(&self, app: &AppHandle) -> Result<()> {
        let session = self
            .inner
            .lock()
            .map_err(|_| anyhow!("無法取得即時字幕狀態"))?
            .take()
            .ok_or_else(|| anyhow!("目前沒有進行中的即時字幕"))?;
        session.running.store(false, Ordering::SeqCst);
        let _ = session.stop_tx.send(());
        let _ = session.handle.join();
        let _ = app.emit(
            LIVE_CAPTION_STATUS_EVENT,
            LiveCaptionStatus {
                active: false,
                backend: Some(session.backend),
                audio_source: Some(session.audio_source),
            },
        );
        Ok(())
    }

    pub fn status(&self) -> LiveCaptionStatus {
        let guard = match self.inner.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return LiveCaptionStatus {
                    active: false,
                    backend: None,
                    audio_source: None,
                }
            }
        };
        guard
            .as_ref()
            .map(|session| LiveCaptionStatus {
                active: session.running.load(Ordering::SeqCst),
                backend: Some(session.backend.clone()),
                audio_source: Some(session.audio_source.clone()),
            })
            .unwrap_or(LiveCaptionStatus {
                active: false,
                backend: None,
                audio_source: None,
            })
    }

    /// 供主控制面板切換「鎖定」（＝穿透模式）。
    /// 鎖定開啟：視窗預設穿透，游標移到標題列／邊框時 watcher 仍會動態恢復互動。
    /// 鎖定關閉：視窗恆為可互動，watcher 不再套用穿透。
    pub fn set_lock(&self, app: &AppHandle, locked: bool) -> Result<()> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| anyhow!("無法取得即時字幕狀態"))?;
        let session = guard
            .as_ref()
            .ok_or_else(|| anyhow!("目前沒有進行中的即時字幕"))?;
        session
            .click_through_enabled
            .store(locked, Ordering::SeqCst);
        drop(guard);
        // 鎖定關閉時立即恢復互動；鎖定開啟時交由 watcher 依游標位置判斷起始狀態。
        if !locked {
            set_overlay_click_through(app, false)?;
            let _ = app.emit(LIVE_CAPTION_INTERACTIVE_EVENT, true);
        }
        Ok(())
    }
}

pub fn build_info() -> LiveCaptionBuildInfo {
    LiveCaptionBuildInfo {
        cuda_enabled: cfg!(feature = "live-caption-cuda"),
    }
}

pub fn list_audio_sources() -> Result<RecordingDeviceList> {
    audio_recording::list_recording_devices()
}

fn normalize_backend(backend: &str) -> Result<String> {
    match backend {
        "local_whisper" | "local" => Ok("local_whisper".into()),
        "voxnote_asr" => Ok("voxnote_asr".into()),
        other => Err(anyhow!("不支援的即時字幕轉錄後端：{}", other)),
    }
}

fn validate_audio_source(source: &str) -> Result<()> {
    match source {
        "microphone" => Ok(()),
        "system" if cfg!(target_os = "windows") => Ok(()),
        "system" => Err(anyhow!("目前平台不支援電腦系統音訊擷取")),
        other => Err(anyhow!("不支援的即時字幕音訊來源：{}", other)),
    }
}

/// 即時字幕的遠端端點未設定時，回退沿用批次流程的自架 ASR 位址，
/// 避免既有使用者升級後即時字幕突然失去端點設定。
///
/// 注意：session 由 `start_live_caption` 啟動時，該欄位已被填入解析後的位址
/// （含自動偵測到的 `/live` 子路徑），故此處通常直接回傳該值；本回退僅在
/// 未經該路徑取得 config 時生效。
pub fn live_caption_remote_base_url(config: &AppConfig) -> &str {
    let dedicated = config.live_caption_remote_base_url.trim();
    if dedicated.is_empty() {
        &config.local_asr_base_url
    } else {
        dedicated
    }
}

fn validate_caption_window(config: &AppConfig) -> Result<()> {
    if !(1..=30).contains(&config.live_caption_window_seconds) {
        return Err(anyhow!("即時字幕視窗長度必須介於 1 至 30 秒"));
    }
    if config.live_caption_step_seconds == 0
        || config.live_caption_step_seconds > config.live_caption_window_seconds
    {
        return Err(anyhow!("即時字幕步進必須介於 1 秒與視窗長度之間"));
    }
    if config.live_caption_incremental_enabled
        && (config.live_caption_decode_interval_ms == 0
            || config.live_caption_decode_interval_ms
                >= config.live_caption_window_seconds.saturating_mul(1000))
    {
        return Err(anyhow!(
            "增量字幕解碼間隔必須小於分析視窗長度（目前為 {} ms，視窗為 {} 秒）",
            config.live_caption_decode_interval_ms,
            config.live_caption_window_seconds
        ));
    }
    if !(0.0..=1.0).contains(&config.live_caption_silence_threshold) {
        return Err(anyhow!("即時字幕靜音門檻必須介於 0 與 1 之間"));
    }
    Ok(())
}

fn run_live_caption_session(
    app: AppHandle,
    config: AppConfig,
    backend: String,
    audio_source: String,
    queue: SharedQueue,
    error_state: SharedError,
    running: Arc<AtomicBool>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    let whisper_context = if backend == "local_whisper" {
        Some(
            WhisperContext::new_with_params(
                config.live_caption_model_path.trim(),
                WhisperContextParameters::default(),
            )
            .map_err(|error| anyhow!("無法載入即時字幕模型：{}", error))?,
        )
    } else {
        None
    };

    let level_value = Arc::new(Mutex::new(0.0f32));
    let mic_stream = if audio_source == "microphone" {
        let selected = audio_recording::select_input_device(None)?;
        let stream = audio_recording::start_microphone_stream(
            selected.device,
            queue.clone(),
            error_state.clone(),
            level_value.clone(),
            SAMPLE_RATE,
        )?;
        stream
            .play()
            .map_err(|error| anyhow!("無法啟動即時字幕麥克風：{error}"))?;
        Some(stream)
    } else {
        None
    };

    #[cfg(target_os = "windows")]
    let loopback_handle = if audio_source == "system" {
        Some(audio_recording::start_windows_loopback_capture(
            None,
            queue.clone(),
            error_state.clone(),
            running.clone(),
            level_value,
            SAMPLE_RATE,
        )?)
    } else {
        None
    };
    #[cfg(not(target_os = "windows"))]
    let loopback_handle: Option<thread::JoinHandle<Result<()>>> = None;

    // 供本 session 所有視窗共用，避免每視窗重建連線與 TLS 交握。
    let remote_client = if backend == "voxnote_asr" {
        Some(
            reqwest::Client::builder()
                .build()
                .map_err(|error| anyhow!("無法建立即時字幕遠端連線：{}", error))?,
        )
    } else {
        None
    };

    ready_tx
        .send(Ok(()))
        .map_err(|_| anyhow!("即時字幕啟動狀態無法回傳"))?;

    let result = process_caption_windows(
        &app,
        &config,
        &backend,
        whisper_context.as_ref(),
        remote_client.as_ref(),
        &queue,
        &error_state,
        &running,
        stop_rx,
    );

    running.store(false, Ordering::SeqCst);
    drop(mic_stream);
    if let Some(handle) = loopback_handle {
        if let Err(error) = handle
            .join()
            .map_err(|_| anyhow!("系統音訊擷取執行緒異常中止"))?
        {
            if result.is_ok() {
                emit_error(&app, error.to_string());
            }
        }
    }
    close_overlay(&app);
    let _ = app.emit(
        LIVE_CAPTION_STATUS_EVENT,
        LiveCaptionStatus {
            active: false,
            backend: Some(backend),
            audio_source: Some(audio_source),
        },
    );
    result
}

fn process_caption_windows(
    app: &AppHandle,
    config: &AppConfig,
    backend: &str,
    whisper_context: Option<&WhisperContext>,
    remote_client: Option<&reqwest::Client>,
    queue: &SharedQueue,
    error_state: &SharedError,
    running: &Arc<AtomicBool>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<()> {
    let window_samples = config.live_caption_window_seconds as usize * SAMPLE_RATE as usize;
    let step_samples = config.live_caption_step_seconds as usize * SAMPLE_RATE as usize;
    let max_pending_samples = MAX_PENDING_AUDIO_SECONDS * SAMPLE_RATE as usize;
    let mut samples = VecDeque::new();
    let mut recent_results: VecDeque<String> = VecDeque::new();
    let mut agreement = LocalAgreement::default();
    let mut incremental = config.live_caption_incremental_enabled;
    let decode_interval = Duration::from_millis(config.live_caption_decode_interval_ms as u64);
    let mut last_decode_at: Option<Instant> = None;
    let mut incremental_fallback_reported = false;
    let mut incremental_segment = IncrementalSegmentState::default();
    let mut captured_sample_offset = 0usize;
    let translation_failure_reported = Arc::new(AtomicBool::new(false));
    let mut sequence = 0u64;
    let mut last_drop_notice: Option<Instant> = None;

    while running.load(Ordering::SeqCst) {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        if let Some(error) = take_error(error_state) {
            return Err(error);
        }

        captured_sample_offset += drain_queue(queue, &mut samples);
        if samples.len() > max_pending_samples {
            let overflow = samples.len() - max_pending_samples;
            for _ in 0..overflow {
                let _ = samples.pop_front();
            }
            let should_notify = last_drop_notice
                .map(|at| at.elapsed() >= DROP_NOTICE_THROTTLE)
                .unwrap_or(true);
            if should_notify {
                last_drop_notice = Some(Instant::now());
                emit_error(
                    app,
                    "轉錄速度跟不上聲音，已捨棄部分較舊音訊以追上進度".into(),
                );
            }
        }

        if incremental && incremental_segment.is_expired() {
            complete_incremental_segment(
                app,
                config,
                &mut agreement,
                &mut incremental_segment,
                &mut samples,
                captured_sample_offset,
                &translation_failure_reported,
            );
        }
        let interval_elapsed = last_decode_at
            .map(|started| started.elapsed() >= decode_interval)
            .unwrap_or(true);
        if (!incremental && samples.len() < window_samples) || (incremental && !interval_elapsed) {
            thread::sleep(CAPTURE_POLL_INTERVAL);
            continue;
        }

        // 推論可能比擷取音訊更慢；每次取最新視窗，避免字幕逐段追播舊音訊。
        let available_samples = samples.len();
        println!(
            "[live-caption][timing] 取樣時佇列堆積={:.1}秒（上限 {} 秒）",
            available_samples as f64 / SAMPLE_RATE as f64,
            MAX_PENDING_AUDIO_SECONDS
        );
        let current_window_samples = available_samples.min(window_samples);
        let window: Vec<f32> = samples
            .iter()
            .skip(available_samples - current_window_samples)
            .copied()
            .collect();
        let keep_samples = if incremental {
            window_samples
        } else {
            window_samples.saturating_sub(step_samples)
        };
        let drop_samples = available_samples.saturating_sub(keep_samples);
        for _ in 0..drop_samples {
            let _ = samples.pop_front();
        }
        // 視窗涵蓋的音訊已擷取完畢的時間點；用於量測「聲音發生」到「字幕顯示」的實際延遲，
        // 而非僅轉錄本身耗時（後者不含視窗填滿等待與佇列處理排隊時間）。
        let window_ready_at = Instant::now();

        let peak = window
            .iter()
            .fold(0.0f32, |max, sample| max.max(sample.abs()));
        if incremental {
            // 靜音視窗也要消耗本次解碼節奏，避免在同一個視窗上每 25ms 空轉檢查。
            last_decode_at = Some(Instant::now());
        }
        if peak < config.live_caption_silence_threshold {
            continue;
        }

        let transcribe_started_at = Instant::now();
        let transcription = match backend {
            "local_whisper" => transcribe_with_whisper(
                whisper_context.ok_or_else(|| anyhow!("本地 Whisper 模型未初始化"))?,
                &window,
                &config.live_caption_language,
            ),
            "voxnote_asr" => {
                if incremental {
                    tauri::async_runtime::block_on(
                        crate::asr::transcribe_live_caption_remote_incremental(
                            remote_client.ok_or_else(|| anyhow!("即時字幕遠端連線未初始化"))?,
                            live_caption_remote_base_url(config),
                            &window,
                            &config.live_caption_language,
                            config.live_caption_remote_timeout_seconds as u64,
                        ),
                    )
                } else {
                    tauri::async_runtime::block_on(transcribe_live_caption_remote(
                        remote_client.ok_or_else(|| anyhow!("即時字幕遠端連線未初始化"))?,
                        live_caption_remote_base_url(config),
                        &window,
                        &config.live_caption_language,
                        config.live_caption_remote_timeout_seconds as u64,
                    ))
                }
            }
            _ => Err(anyhow!("不支援的即時字幕轉錄後端：{}", backend)),
        };
        if incremental {
            // 以解碼完成時間作為節奏基準；若單次解碼已超過間隔，下一輪會等待
            // 下一個間隔而不是立即補跑，避免待處理工作無限累積。
            last_decode_at = Some(Instant::now());
        }
        println!(
            "[live-caption][timing] 後端={} 轉錄耗時={:.2}秒",
            backend,
            transcribe_started_at.elapsed().as_secs_f64()
        );

        let transcription = match transcription {
            Ok(text) if !text.trim().is_empty() => {
                println!("[live-caption] 後端={} 原始輸出={:?}", backend, text.trim());
                if is_hallucination(&text) {
                    println!("[live-caption] 判定為模型幻覺，略過本段");
                    continue;
                }
                text.trim().to_string()
            }
            Ok(_) => {
                println!("[live-caption] 後端={} 回傳空字串，略過", backend);
                continue;
            }
            Err(error) => {
                println!("[live-caption] 後端={} 轉錄失敗：{}", backend, error);
                if incremental && backend == "voxnote_asr" && !incremental_fallback_reported {
                    incremental_fallback_reported = true;
                    incremental = false;
                    emit_error(
                        app,
                        format!("低延遲增量端點不可用，已回退至視窗式字幕輸出：{}", error),
                    );
                    // 增量端點不支援時，不中止 session；後續請求改走既有批次同步契約。
                    // 此處以局部旗標控制本次 session，不修改使用者設定。
                    // `incremental` 為不可變設定快照，故透過回退旗標判斷後續路徑。
                } else if !incremental_fallback_reported {
                    emit_error(app, format!("單段即時字幕轉錄失敗，將繼續處理：{}", error));
                }
                continue;
            }
        };
        if !incremental && is_duplicate(&recent_results, &transcription) {
            println!("[live-caption] 與近期輸出高度相似，判定為重疊，略過");
            continue;
        }
        let text = transcription.clone();
        if !incremental {
            push_recent_result(&mut recent_results, transcription);
        }

        println!(
            "[live-caption][timing] 視窗結束到字幕顯示的延遲={:.2}秒",
            window_ready_at.elapsed().as_secs_f64()
        );
        let (confirmed_text, tentative_text, is_tentative) = if incremental {
            let update = agreement.update(&text);
            let is_tentative = !update.tentative.is_empty();
            (update.confirmed, update.tentative, is_tentative)
        } else {
            (text.clone(), String::new(), false)
        };
        let event_sequence = if incremental {
            if incremental_segment.sequence.is_none() {
                sequence += 1;
                incremental_segment.start(sequence);
            }
            match incremental_segment.sequence {
                Some(value) => value,
                None => continue,
            }
        } else {
            sequence += 1;
            sequence
        };
        let emitted_text = if incremental {
            format!("{}{}", confirmed_text, tentative_text)
        } else {
            text.clone()
        };
        if incremental {
            incremental_segment.text = emitted_text.clone();
            let segment_samples =
                captured_sample_offset.saturating_sub(incremental_segment.committed_sample_offset);
            println!(
                "[live-caption] 當前字幕段已提交游標={}，段內擷取樣本={}",
                incremental_segment.committed_sample_offset, segment_samples
            );
        }
        let display_text =
            build_display_text(&emitted_text, None, &config.live_caption_display_mode);
        let _ = app.emit(
            LIVE_CAPTION_EVENT,
            LiveCaptionPayload {
                sequence: event_sequence,
                original: emitted_text.clone(),
                translation: None,
                display_text,
                confirmed_text: confirmed_text.clone(),
                tentative_text: tentative_text.clone(),
                is_tentative,
            },
        );

        let (should_translate, should_proofread) = resolve_translate_or_proofread(
            config.live_caption_translate,
            config.live_caption_proofread,
            &config.live_caption_display_mode,
            &config.live_caption_language,
        );

        if should_translate && !incremental {
            let translation_app = app.clone();
            let translation_config = config.clone();
            let translation_text = emitted_text.clone();
            let translation_sequence = event_sequence;
            let translation_mode = config.live_caption_display_mode.clone();
            let translation_failure_reported = translation_failure_reported.clone();
            // 翻譯不得阻塞下一段 ASR；完成後用相同 sequence 更新已顯示的字幕。
            thread::spawn(move || {
                match tauri::async_runtime::block_on(call_llm(
                    &translation_config,
                    "你是即時字幕翻譯員。請將輸入內容翻譯成自然、簡潔的繁體中文台灣用語。只輸出譯文，不要加註解、前綴或引號。",
                    &translation_text,
                )) {
                    Ok(value) if !value.trim().is_empty() => {
                        let value = value.trim().to_string();
                        translation_failure_reported.store(false, Ordering::SeqCst);
                        let _ = translation_app.emit(
                            LIVE_CAPTION_EVENT,
                            LiveCaptionPayload {
                                sequence: translation_sequence,
                                original: translation_text.clone(),
                                display_text: build_display_text(
                                    &translation_text,
                                    Some(&value),
                                    &translation_mode,
                                ),
                                translation: Some(value),
                                confirmed_text: translation_text.clone(),
                                tentative_text: String::new(),
                                is_tentative: false,
                            },
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        if !translation_failure_reported.swap(true, Ordering::SeqCst) {
                            emit_error(
                                &translation_app,
                                format!("字幕翻譯暫時不可用，將維持顯示原文：{}", error),
                            );
                        }
                    }
                }
            });
        } else if should_proofread && !incremental {
            let proofread_app = app.clone();
            let proofread_config = config.clone();
            let proofread_text = emitted_text.clone();
            let proofread_sequence = event_sequence;
            let proofread_failure_reported = translation_failure_reported.clone();
            // 校稿是「修正原文」而非另一種呈現，故以校正後文字取代 original／
            // display_text，translation 欄位維持 None——與翻譯的語意區分開來。
            thread::spawn(move || {
                match tauri::async_runtime::block_on(call_llm(
                    &proofread_config,
                    PROOFREAD_CORE_SYSTEM,
                    &proofread_text,
                )) {
                    Ok(value) if !value.trim().is_empty() => {
                        let value = value.trim().to_string();
                        proofread_failure_reported.store(false, Ordering::SeqCst);
                        let _ = proofread_app.emit(
                            LIVE_CAPTION_EVENT,
                            LiveCaptionPayload {
                                sequence: proofread_sequence,
                                original: value.clone(),
                                // 不透過 build_display_text：該函式依 mode 在原文／譯文間選擇，
                                // 但此處沒有「譯文」，三種 mode 目前都恰好收斂回 value，純屬巧合
                                // （並非刻意設計）。直接指定 value，避免日後修改
                                // build_display_text 的行為時，此處被意外連動改變。
                                display_text: value.clone(),
                                translation: None,
                                confirmed_text: value.clone(),
                                tentative_text: String::new(),
                                is_tentative: false,
                            },
                        );
                    }
                    Ok(_) => {}
                    Err(error) => {
                        if !proofread_failure_reported.swap(true, Ordering::SeqCst) {
                            emit_error(
                                &proofread_app,
                                format!("字幕校稿暫時不可用，將維持顯示原文：{}", error),
                            );
                        }
                    }
                }
            });
        }
    }

    if incremental && (agreement.has_text() || incremental_segment.sequence.is_some()) {
        complete_incremental_segment(
            app,
            config,
            &mut agreement,
            &mut incremental_segment,
            &mut samples,
            captured_sample_offset,
            &translation_failure_reported,
        );
    }

    Ok(())
}

fn transcribe_with_whisper(
    context: &WhisperContext,
    samples: &[f32],
    language: &str,
) -> Result<String> {
    let mut state = context
        .create_state()
        .context("無法建立 Whisper 推論狀態")?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language((language != "auto" && !language.is_empty()).then_some(language));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_nst(true);

    // 即時字幕的每個視窗都是獨立片段，若沿用前一次的解碼上下文，
    // 一旦出現幻覺就會被當成提示不斷延續到後續片段。
    params.set_no_context(true);
    // 抑制模型在無語音時輸出空白起手式，降低幻覺開場的機率。
    params.set_suppress_blank(true);
    // 固定為貪婪解碼且不做溫度回退：溫度回退會在信心不足時改用隨機取樣，
    // 對短視窗而言更容易掰出訓練資料裡的常見字幕文字。
    params.set_temperature(0.0);
    params.set_temperature_inc(0.0);
    // 即時字幕的視窗短於 Whisper 原生的 30 秒設計，短片段的信心分數略偏低，
    // 故較預設（-1.0／2.4）稍微放寬，但不再沿用先前的 -2.0／3.2——那組值等同關閉把關。
    // 注意：這兩項僅為一般性把關，不足以擋下實測到的幻覺
    // （"Thank you for watching!" 的 avg_logprobs = -0.967、entropy = 1.946，
    // 兩者皆優於此處門檻）。該類幻覺實際由下方逐段的 no_speech 判定
    // 與 HALLUCINATION_MARKERS 字串比對攔截。
    params.set_logprob_thold(-1.2);
    params.set_entropy_thold(2.8);
    state
        .full(params, samples)
        .context("Whisper 即時推論失敗")?;

    let segment_count = state.full_n_segments();
    let mut text = String::new();
    for index in 0..segment_count {
        let segment = state
            .get_segment(index)
            .ok_or_else(|| anyhow!("無法讀取 Whisper 段落"))?;
        // whisper-rs 0.16 的 set_no_speech_thold 於上游尚未實作（見其 whisper_params.rs
        // 註解「Currently (as of v1.3.0) not implemented」），設定該參數不會生效，
        // 故改由此處逐段自行判定，濾除模型自認多半非語音卻仍吐字的段落。
        if segment.no_speech_probability() > SEGMENT_NO_SPEECH_MAX {
            println!("[live-caption] 段落 {} 非語音機率超過門檻，略過該段", index);
            continue;
        }
        text.push_str(&segment.to_str().context("無法讀取 Whisper 轉錄文字")?);
    }
    Ok(text.trim().to_string())
}

/// Whisper 訓練資料含有大量網路影片字幕，音訊資訊不足時會傾向輸出其中的字幕組署名
/// 或訂閱標語。這些字串不會出現在正常會議或演講內容中，故一律視為幻覺濾除。
const HALLUCINATION_MARKERS: &[&str] = &[
    "字幕by",
    "字幕 by",
    "字幕組",
    "字幕组",
    "字幕志願者",
    "字幕志愿者",
    "索兰娅",
    "索蘭雅",
    // 僅比對完整的字幕組標語，不單獨比對「訂閱」「轉發」等詞：
    // 技術演講中 pub/sub 的訂閱、封包轉發都是正常用語，單獨比對會誤刪正確字幕。
    "請不吝點贊",
    "请不吝点赞",
    "點贊 訂閱",
    "点赞 订阅",
    "訂閱 轉發",
    "订阅 转发",
    "轉發 打賞",
    "转发 打赏",
    "明鏡與點點欄目",
    "明镜与点点栏目",
    "上集回顧",
    "上集回顾",
    "下集預告",
    "下集预告",
    "本字幕由",
    "感謝觀看",
    "感谢观看",
    "多謝收看",
    "多谢收看",
    "Amara.org",
    "amara.org",
    "MBC 뉴스",
    "ご視聴ありがとうございました",
    // 英文幻覺：Whisper 的訓練資料含大量 YouTube 影片，音訊資訊不足時會傾向
    // 補出影片結尾的固定套語。以下皆為完整片語比對，不單獨比對 "thank you"、
    // "subscribe" 等常用詞，避免刪掉正常英文語音。
    "thank you for watching",
    "thanks for watching",
    "thank you so much for watching",
    "thank you for your watching",
    "please subscribe",
    "don't forget to subscribe",
    "like and subscribe",
    "see you in the next video",
    "see you next video",
    "subtitles by",
    "transcription by",
    "transcribed by",
];

/// 判斷單段轉錄結果是否為模型幻覺。
fn is_hallucination(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return true;
    }
    let lowered = trimmed.to_lowercase();
    if HALLUCINATION_MARKERS
        .iter()
        .any(|marker| lowered.contains(&marker.to_lowercase()))
    {
        return true;
    }
    // 僅由標點或符號組成的輸出同樣沒有意義。
    if !trimmed.chars().any(char::is_alphanumeric) {
        return true;
    }
    false
}

fn drain_queue(queue: &SharedQueue, target: &mut VecDeque<f32>) -> usize {
    let mut drained = 0;
    if let Ok(mut source) = queue.lock() {
        drained = source.len();
        target.extend(source.drain(..));
    }
    drained
}

/// 完成目前的顯示段。此生命週期只由固定顯示週期或 session 結束觸發，
/// 不依賴標點、agreement 或模型是否仍重送舊前綴。
fn complete_incremental_segment(
    app: &AppHandle,
    config: &AppConfig,
    agreement: &mut LocalAgreement,
    segment: &mut IncrementalSegmentState,
    samples: &mut VecDeque<f32>,
    captured_sample_offset: usize,
    translation_failure_reported: &Arc<AtomicBool>,
) {
    let final_text = if agreement.has_text() {
        agreement.finish().confirmed
    } else {
        segment.text.trim().to_string()
    };
    let completed = segment.complete(captured_sample_offset);
    if let Some((event_sequence, _)) = completed {
        if !final_text.is_empty() {
            let _ = app.emit(
                LIVE_CAPTION_EVENT,
                LiveCaptionPayload {
                    sequence: event_sequence,
                    original: final_text.clone(),
                    translation: None,
                    display_text: build_display_text(
                        &final_text,
                        None,
                        &config.live_caption_display_mode,
                    ),
                    confirmed_text: final_text.clone(),
                    tentative_text: String::new(),
                    is_tentative: false,
                },
            );
            spawn_caption_postprocessing(
                app,
                config,
                event_sequence,
                final_text,
                translation_failure_reported,
            );
        }
    }
    *agreement = LocalAgreement::default();
    samples.clear();
}

fn spawn_caption_postprocessing(
    app: &AppHandle,
    config: &AppConfig,
    sequence: u64,
    text: String,
    failure_reported: &Arc<AtomicBool>,
) {
    let (should_translate, should_proofread) = resolve_translate_or_proofread(
        config.live_caption_translate,
        config.live_caption_proofread,
        &config.live_caption_display_mode,
        &config.live_caption_language,
    );
    if !should_translate && !should_proofread {
        return;
    }

    let app = app.clone();
    let config = config.clone();
    let mode = config.live_caption_display_mode.clone();
    let failure_reported = failure_reported.clone();
    thread::spawn(move || {
        let result = if should_translate {
            tauri::async_runtime::block_on(call_llm(
                &config,
                "你是即時字幕翻譯員。請將輸入內容翻譯成自然、簡潔的繁體中文台灣用語。只輸出譯文，不要加註解、前綴或引號。",
                &text,
            ))
        } else {
            tauri::async_runtime::block_on(call_llm(&config, PROOFREAD_CORE_SYSTEM, &text))
        };

        match result {
            Ok(value) if !value.trim().is_empty() => {
                let value = value.trim().to_string();
                failure_reported.store(false, Ordering::SeqCst);
                let payload = if should_translate {
                    LiveCaptionPayload {
                        sequence,
                        original: text.clone(),
                        display_text: build_display_text(&text, Some(&value), &mode),
                        translation: Some(value),
                        confirmed_text: text.clone(),
                        tentative_text: String::new(),
                        is_tentative: false,
                    }
                } else {
                    LiveCaptionPayload {
                        sequence,
                        original: value.clone(),
                        display_text: value.clone(),
                        translation: None,
                        confirmed_text: value,
                        tentative_text: String::new(),
                        is_tentative: false,
                    }
                };
                let _ = app.emit(LIVE_CAPTION_EVENT, payload);
            }
            Ok(_) => {}
            Err(error) => {
                if !failure_reported.swap(true, Ordering::SeqCst) {
                    emit_error(
                        &app,
                        format!("字幕後處理暫時不可用，將維持顯示原文：{}", error),
                    );
                }
            }
        }
    });
}

fn take_error(error_state: &SharedError) -> Option<anyhow::Error> {
    error_state
        .lock()
        .ok()
        .and_then(|mut error| error.take())
        .map(|message| anyhow!("{}", message))
}

/// 保留供比對的最近已輸出結果筆數（參考實作 `translate_meeting.py` 的
/// `deque(maxlen=10)`）。滑動視窗重疊時，同一段語音可能被辨識兩次且結果
/// 未必逐字相同，故比對範圍需涵蓋多筆而非僅前一筆。
const RECENT_RESULTS_CAPACITY: usize = 10;
/// 子字串重疊度門檻：兩段文字中較短者，有超過此比例的內容是另一段的子字串。
const OVERLAP_RATIO_THRESHOLD: f64 = 0.7;
/// 字元相似度門檻（Levenshtein 距離換算的相似比）。
const SIMILARITY_RATIO_THRESHOLD: f64 = 0.6;
/// 短句長度門檻：短於此長度的文字不參與相似度判定，避免短句被誤判為重複。
const DUPLICATE_MIN_LENGTH: usize = 8;

fn push_recent_result(recent_results: &mut VecDeque<String>, text: String) {
    if recent_results.len() >= RECENT_RESULTS_CAPACITY {
        recent_results.pop_front();
    }
    recent_results.push_back(text);
}

/// 判斷 `current` 是否與 `recent_results` 中任一筆高度重疊，視為重複視窗。
///
/// 雙重判定：子字串重疊度（其一為另一子字串時比例超過門檻）或字元相似度
/// （Levenshtein 相似比超過門檻），符合任一者即視為重複。取自參考實作
/// `is_duplicate()` 的判定邏輯。
fn is_duplicate(recent_results: &VecDeque<String>, current: &str) -> bool {
    let current_normalized: Vec<char> = current
        .chars()
        .filter(|char| !char.is_whitespace())
        .collect();
    if current_normalized.len() < DUPLICATE_MIN_LENGTH {
        return false;
    }
    recent_results.iter().any(|previous| {
        let previous_normalized: Vec<char> = previous
            .chars()
            .filter(|char| !char.is_whitespace())
            .collect();
        if previous_normalized.len() < DUPLICATE_MIN_LENGTH {
            return false;
        }
        substring_overlap_ratio(&previous_normalized, &current_normalized) > OVERLAP_RATIO_THRESHOLD
            || char_similarity_ratio(&previous_normalized, &current_normalized)
                > SIMILARITY_RATIO_THRESHOLD
    })
}

/// 較短序列有多大比例是較長序列的子字串（以較長的公共子字串長度估算）。
fn substring_overlap_ratio(a: &[char], b: &[char]) -> f64 {
    let (shorter, longer) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if shorter.is_empty() {
        return 0.0;
    }
    let overlap = longest_common_substring_len(shorter, longer);
    overlap as f64 / shorter.len() as f64
}

fn longest_common_substring_len(a: &[char], b: &[char]) -> usize {
    let mut previous_row = vec![0usize; b.len() + 1];
    let mut best = 0;
    for a_char in a {
        let mut current_row = vec![0usize; b.len() + 1];
        for (index, b_char) in b.iter().enumerate() {
            if a_char == b_char {
                current_row[index + 1] = previous_row[index] + 1;
                best = best.max(current_row[index + 1]);
            }
        }
        previous_row = current_row;
    }
    best
}

/// 以 Levenshtein 編輯距離換算相似比：`1 - 距離 / 較長長度`，對應
/// `difflib.SequenceMatcher.ratio()` 的量級（非逐位元相同實作，但同樣
/// 反映「需多少編輯才能讓兩段文字相同」）。
fn char_similarity_ratio(a: &[char], b: &[char]) -> f64 {
    let max_len = a.len().max(b.len());
    if max_len == 0 {
        return 1.0;
    }
    let distance = levenshtein_distance(a, b);
    1.0 - (distance as f64 / max_len as f64)
}

fn levenshtein_distance(a: &[char], b: &[char]) -> usize {
    let mut previous_row: Vec<usize> = (0..=b.len()).collect();
    for (i, a_char) in a.iter().enumerate() {
        let mut current_row = vec![i + 1];
        for (j, b_char) in b.iter().enumerate() {
            let cost = if a_char == b_char { 0 } else { 1 };
            let value = (previous_row[j + 1] + 1)
                .min(current_row[j] + 1)
                .min(previous_row[j] + cost);
            current_row.push(value);
        }
        previous_row = current_row;
    }
    previous_row[b.len()]
}

/// 決定單段字幕應執行翻譯或校稿，兩者最多擇一。
///
/// 翻譯與校稿互斥：來源語言為中文時（翻譯目標與來源相同），翻譯是 no-op，
/// 改執行校稿；來源語言非中文時，校稿的「輸出語言等於輸入語言」前提不成立，
/// 執行翻譯。
///
/// 「auto」情境無法在此得知實際轉錄語言（whisper 逐段偵測結果未回傳至此層級），
/// 故不試圖精準判斷，一律視為需要翻譯的情境——只有明確指定來源語言為中文時，
/// 才確定目標與來源相同。
fn resolve_translate_or_proofread(
    translate_enabled: bool,
    proofread_enabled: bool,
    display_mode: &str,
    source_language: &str,
) -> (bool, bool) {
    let source_is_chinese = source_language == "zh";
    let should_translate = translate_enabled && display_mode != "original" && !source_is_chinese;
    let should_proofread = proofread_enabled && source_is_chinese;
    (should_translate, should_proofread)
}

fn build_display_text(original: &str, translation: Option<&str>, mode: &str) -> String {
    match mode {
        "original" => original.to_string(),
        "both" => match translation {
            Some(translation) => format!("{}\n{}", original, translation),
            None => original.to_string(),
        },
        _ => translation.unwrap_or(original).to_string(),
    }
}

fn emit_error(app: &AppHandle, message: String) {
    let _ = app.emit(
        LIVE_CAPTION_ERROR_EVENT,
        LiveCaptionErrorPayload { message },
    );
}

/// 將字幕視窗設為預設大小（約可容納兩行文字）與位置（螢幕下方三分之一處、
/// 水平置中）。失敗時僅記錄，不影響字幕啟動——使用者原本就能手動調整視窗。
fn apply_default_overlay_geometry(overlay: &tauri::WebviewWindow) {
    let monitor = match overlay.current_monitor() {
        Ok(Some(monitor)) => monitor,
        Ok(None) => {
            println!("[live-caption] 找不到目前所在螢幕，略過套用預設視窗位置");
            return;
        }
        Err(error) => {
            println!("[live-caption] 無法取得螢幕資訊，略過套用預設視窗位置：{error}");
            return;
        }
    };
    // 使用該螢幕自身的 scale_factor／position，避免與其他螢幕的縮放或座標混用。
    let scale = monitor.scale_factor();
    let monitor_origin_x_logical = monitor.position().x as f64 / scale;
    let monitor_origin_y_logical = monitor.position().y as f64 / scale;
    let screen_width_logical = monitor.size().width as f64 / scale;
    let screen_height_logical = monitor.size().height as f64 / scale;

    let width = OVERLAY_DEFAULT_WIDTH_LOGICAL.min(screen_width_logical);
    let height = OVERLAY_DEFAULT_HEIGHT_LOGICAL;
    let x = monitor_origin_x_logical + (screen_width_logical - width) / 2.0;
    // 視窗頂部落在螢幕高度 72% 處，使視窗主體落於螢幕下方三分之一區域內。
    let y = monitor_origin_y_logical + screen_height_logical * 0.72;

    if let Err(error) = overlay.set_size(tauri::LogicalSize::new(width, height)) {
        println!("[live-caption] 無法設定字幕視窗預設大小：{error}");
    }
    if let Err(error) = overlay.set_position(tauri::LogicalPosition::new(
        x.max(monitor_origin_x_logical),
        y.max(monitor_origin_y_logical),
    )) {
        println!("[live-caption] 無法設定字幕視窗預設位置：{error}");
    }
}

/// 切換字幕視窗的點擊穿透狀態。
pub fn set_overlay_click_through(app: &AppHandle, ignore: bool) -> Result<()> {
    let window = app
        .get_webview_window(LIVE_CAPTION_OVERLAY_LABEL)
        .ok_or_else(|| anyhow!("找不到即時字幕浮動視窗"))?;
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|error| anyhow!("無法設定點擊穿透：{error}"))
}

/// 依游標位置動態切換點擊穿透。
///
/// 視窗處於穿透狀態時收不到任何滑鼠事件（含 mousemove），因此無法由前端偵測游標進入邊框。
/// 此處改由背景執行緒輪詢全域游標座標：游標位於標題列或視窗邊框感應區時關閉穿透以便操作，
/// 移開後恢復穿透，讓下層的影片可以被點擊。
fn spawn_click_through_watcher(
    app: AppHandle,
    running: Arc<AtomicBool>,
    click_through_enabled: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut interactive: Option<bool> = None;
        while running.load(Ordering::SeqCst) {
            thread::sleep(CLICK_THROUGH_POLL_INTERVAL);
            let Some(window) = app.get_webview_window(LIVE_CAPTION_OVERLAY_LABEL) else {
                break;
            };

            // 鎖定關閉時視窗恆為可互動，不套用穿透判斷。
            let should_interact = if !click_through_enabled.load(Ordering::SeqCst) {
                true
            } else {
                let (Ok(cursor), Ok(position), Ok(size)) = (
                    window.cursor_position(),
                    window.outer_position(),
                    window.outer_size(),
                ) else {
                    continue;
                };

                let scale = window.scale_factor().unwrap_or(1.0);
                let edge = OVERLAY_EDGE_ZONE_LOGICAL * scale;
                let header = OVERLAY_HEADER_HEIGHT_LOGICAL * scale;
                let left = position.x as f64;
                let top = position.y as f64;
                let right = left + size.width as f64;
                let bottom = top + size.height as f64;

                let inside =
                    cursor.x >= left && cursor.x <= right && cursor.y >= top && cursor.y <= bottom;
                // 標題列與四邊感應區需要互動；字幕文字區維持穿透。
                inside
                    && (cursor.y <= top + header
                        || cursor.x <= left + edge
                        || cursor.x >= right - edge
                        || cursor.y <= top + edge
                        || cursor.y >= bottom - edge)
            };

            if interactive != Some(should_interact) {
                interactive = Some(should_interact);
                let _ = window.set_ignore_cursor_events(!should_interact);
                let _ = app.emit(LIVE_CAPTION_INTERACTIVE_EVENT, should_interact);
            }
        }
        // session 結束時恢復可互動，避免視窗殘留在穿透狀態。
        if let Some(window) = app.get_webview_window(LIVE_CAPTION_OVERLAY_LABEL) {
            let _ = window.set_ignore_cursor_events(false);
        }
    });
}

fn close_overlay(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LIVE_CAPTION_OVERLAY_LABEL) {
        // 靜態宣告的視窗需保留，下一次 session 才能再次顯示。
        let _ = window.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_display_text, is_duplicate, is_hallucination, nearest_font_size_preset,
        push_recent_result, resolve_translate_or_proofread, IncrementalSegmentState,
    };
    use std::collections::VecDeque;
    use std::time::{Duration, Instant};

    #[test]
    fn only_translation_enabled_with_different_source_language_translates() {
        // add-live-caption-overlay spec: 「User watches foreign-language content
        // with translation enabled」
        let (translate, proofread) =
            resolve_translate_or_proofread(true, false, "translation", "en");
        assert!(translate);
        assert!(!proofread);
    }

    #[test]
    fn only_proofread_enabled_with_chinese_source_proofreads() {
        // spec: 「User enables proofreading for same-language content」
        let (translate, proofread) = resolve_translate_or_proofread(false, true, "original", "zh");
        assert!(!translate);
        assert!(proofread);
    }

    #[test]
    fn both_enabled_with_different_languages_only_translates() {
        // spec: 「User enables both translation and proofreading with
        // different languages」——校稿於跨語言情境 MUST NOT 生效
        let (translate, proofread) =
            resolve_translate_or_proofread(true, true, "translation", "en");
        assert!(translate);
        assert!(!proofread);
    }

    #[test]
    fn only_translation_enabled_with_chinese_source_skips_llm_call() {
        // spec: 「System skips the LLM call when translation would be a
        // no-op」——僅翻譯、來源為中文時兩者皆不執行
        let (translate, proofread) =
            resolve_translate_or_proofread(true, false, "translation", "zh");
        assert!(!translate);
        assert!(!proofread);
    }

    #[test]
    fn both_enabled_with_chinese_source_proofreads_not_skipped() {
        // spec: 「Target language equals source language with both enabled」
        // ——此情境校稿本身即為使用者要的處理，MUST NOT 被最佳化跳過
        let (translate, proofread) =
            resolve_translate_or_proofread(true, true, "translation", "zh");
        assert!(!translate);
        assert!(proofread);
    }

    #[test]
    fn auto_source_language_is_treated_as_translation_candidate() {
        // 無法得知 auto 偵測到的實際語言，故一律視為需要翻譯（非中文）的情境；
        // 校稿的「輸出等於輸入語言」前提在此不成立。
        let (translate, proofread) =
            resolve_translate_or_proofread(true, true, "translation", "auto");
        assert!(translate);
        assert!(!proofread);
    }

    #[test]
    fn translate_disabled_by_original_display_mode_does_not_block_proofread() {
        // 迴歸測試：曾誤將翻譯的 display_mode != "original" 判斷套用到校稿，
        // 會導致使用者的既有設定（display_mode = "original"）下校稿永遠不執行。
        let (translate, proofread) = resolve_translate_or_proofread(true, true, "original", "zh");
        assert!(!translate);
        assert!(proofread);
    }

    #[test]
    fn font_size_snaps_to_nearest_preset() {
        assert_eq!(nearest_font_size_preset(28), 28);
        assert_eq!(nearest_font_size_preset(16), 20);
        assert_eq!(nearest_font_size_preset(72), 36);
        // 25 明確較接近 24（差 1）而非 28（差 3），非中點情境。
        assert_eq!(nearest_font_size_preset(25), 24);
    }

    #[test]
    fn overlapping_sliding_window_result_is_flagged_duplicate() {
        // 同一段語音在重疊滑動視窗中被辨識兩次，結果未必逐字相同。
        let mut recent = VecDeque::new();
        push_recent_result(&mut recent, "今天我們要討論系統架構的設計".into());
        assert!(is_duplicate(&recent, "我們要討論系統架構的設計方向"));
    }

    #[test]
    fn distinct_new_content_is_not_flagged_duplicate() {
        let mut recent = VecDeque::new();
        push_recent_result(&mut recent, "今天我們要討論系統架構的設計".into());
        assert!(!is_duplicate(&recent, "接下來進入資料庫的部分"));
    }

    #[test]
    fn short_text_is_not_flagged_duplicate() {
        let mut recent = VecDeque::new();
        push_recent_result(&mut recent, "字幕製作：貝爾".into());
        // 短於 DUPLICATE_MIN_LENGTH 的文字不參與判定，避免短句誤判。
        assert!(!is_duplicate(&recent, "字幕製作"));
    }

    #[test]
    fn recent_results_capacity_evicts_oldest() {
        let mut recent = VecDeque::new();
        for index in 0..12 {
            push_recent_result(&mut recent, format!("片段{}", index));
        }
        assert_eq!(recent.len(), super::RECENT_RESULTS_CAPACITY);
        assert_eq!(recent.front().unwrap(), "片段2");
    }

    #[test]
    fn translation_mode_falls_back_to_original_until_translation_arrives() {
        assert_eq!(
            build_display_text("Original text", None, "translation"),
            "Original text"
        );
    }

    #[test]
    fn subtitle_credit_hallucinations_are_filtered() {
        assert!(is_hallucination("字幕by索兰娅"));
        assert!(is_hallucination("字幕by 索蘭雅"));
        assert!(is_hallucination("請不吝點贊 訂閱 轉發 打賞"));
        assert!(is_hallucination("Subtitles by Amara.org community"));
    }

    #[test]
    fn empty_and_punctuation_only_output_is_filtered() {
        assert!(is_hallucination("   "));
        assert!(is_hallucination("。。。"));
        assert!(is_hallucination("♪♪♪"));
    }

    #[test]
    fn ordinary_speech_is_not_filtered() {
        assert!(!is_hallucination("今天我們要討論的是系統架構"));
        assert!(!is_hallucination("Let's talk about distributed systems."));
    }

    #[test]
    fn english_outro_hallucinations_are_filtered() {
        assert!(is_hallucination("Thank you for watching!"));
        assert!(is_hallucination("Thanks for watching."));
        assert!(is_hallucination("Please subscribe to my channel"));
        assert!(is_hallucination("See you in the next video"));
    }

    /// 英文幻覺清單以完整片語比對，正常語音中出現 thank you、subscribe
    /// 等常用詞不得被誤刪——技術演講談 pub/sub 訂閱即為典型情境。
    #[test]
    fn ordinary_english_containing_common_words_is_not_filtered() {
        assert!(!is_hallucination("Thank you, that answers my question."));
        assert!(!is_hallucination(
            "The client will subscribe to the events topic."
        ));
        assert!(!is_hallucination(
            "I was watching the memory usage closely."
        ));
    }

    #[test]
    fn incremental_segment_completion_advances_sample_cursor() {
        let mut segment = IncrementalSegmentState::default();
        segment.start(1);
        segment.text = "沒有標點的持續語音".into();

        let completed = segment.complete(64_000);

        assert_eq!(completed, Some((1, "沒有標點的持續語音".into())));
        assert_eq!(segment.committed_sample_offset, 64_000);
        assert!(segment.sequence.is_none());
        assert!(segment.started_at.is_none());
    }

    #[test]
    fn incremental_segment_state_allocates_ordered_sequences_for_long_speech() {
        let mut segment = IncrementalSegmentState::default();
        let mut completed = Vec::new();

        for sequence in 1..=3 {
            segment.start(sequence);
            segment.text = format!("segment {sequence}");
            completed.push(segment.complete(sequence as usize * 64_000));
        }

        assert_eq!(
            completed,
            vec![
                Some((1, "segment 1".into())),
                Some((2, "segment 2".into())),
                Some((3, "segment 3".into())),
            ]
        );
    }

    #[test]
    fn incremental_segment_rotates_after_four_seconds_without_punctuation() {
        let mut segment = IncrementalSegmentState::default();
        segment.start(1);
        segment.text = "持續語音沒有標點".into();

        assert!(segment.is_expired_at(Instant::now() + Duration::from_secs(4)));
    }
}
