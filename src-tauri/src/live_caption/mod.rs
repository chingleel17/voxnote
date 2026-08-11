use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use cpal::traits::StreamTrait;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::{
    ai::call_llm,
    asr::transcribe_voxnote_asr_samples,
    audio_recording::{
        self, DesktopRecordingManager, RecordingDeviceList, SharedError, SharedQueue,
    },
    config::AppConfig,
};

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
    pub max_lines: usize,
    pub clear_seconds: u32,
    pub click_through: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveCaptionBuildInfo {
    pub cuda_enabled: bool,
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
                let _ = app.emit(
                    LIVE_CAPTION_SETTINGS_EVENT,
                    LiveCaptionSettingsPayload {
                        font_size: config.live_caption_font_size.clamp(16, 72),
                        max_lines: config.live_caption_max_lines.clamp(1, 10) as usize,
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

    ready_tx
        .send(Ok(()))
        .map_err(|_| anyhow!("即時字幕啟動狀態無法回傳"))?;

    let result = process_caption_windows(
        &app,
        &config,
        &backend,
        whisper_context.as_ref(),
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
    queue: &SharedQueue,
    error_state: &SharedError,
    running: &Arc<AtomicBool>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<()> {
    let window_samples = config.live_caption_window_seconds as usize * SAMPLE_RATE as usize;
    let step_samples = config.live_caption_step_seconds as usize * SAMPLE_RATE as usize;
    let mut samples = VecDeque::new();
    let mut previous_text = String::new();
    let translation_failure_reported = Arc::new(AtomicBool::new(false));
    let mut sequence = 0u64;

    while running.load(Ordering::SeqCst) {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        if let Some(error) = take_error(error_state) {
            return Err(error);
        }

        drain_queue(queue, &mut samples);
        if samples.len() < window_samples {
            thread::sleep(CAPTURE_POLL_INTERVAL);
            continue;
        }

        // 推論可能比擷取音訊更慢；每次取最新視窗，避免字幕逐段追播舊音訊。
        let available_samples = samples.len();
        let window: Vec<f32> = samples
            .iter()
            .skip(available_samples - window_samples)
            .copied()
            .collect();
        let keep_samples = window_samples.saturating_sub(step_samples);
        let drop_samples = available_samples.saturating_sub(keep_samples);
        for _ in 0..drop_samples {
            let _ = samples.pop_front();
        }

        let peak = window
            .iter()
            .fold(0.0f32, |max, sample| max.max(sample.abs()));
        // 診斷用：RMS 比 peak 更能反映整體音量，單一尖峰不會造成誤判。
        let rms = (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt();
        let non_zero = window.iter().filter(|s| s.abs() > 1e-6).count();
        println!(
            "[live-caption] 視窗樣本={} peak={:.6} rms={:.6} 非零樣本={} ({:.1}%) 門檻={:.6}",
            window.len(),
            peak,
            rms,
            non_zero,
            non_zero as f32 / window.len() as f32 * 100.0,
            config.live_caption_silence_threshold,
        );
        if peak < config.live_caption_silence_threshold {
            println!("[live-caption] peak 低於靜音門檻，略過本視窗");
            continue;
        }

        let transcription = match backend {
            "local_whisper" => transcribe_with_whisper(
                whisper_context.ok_or_else(|| anyhow!("本地 Whisper 模型未初始化"))?,
                &window,
                &config.live_caption_language,
            ),
            "voxnote_asr" => tauri::async_runtime::block_on(transcribe_voxnote_asr_samples(
                live_caption_remote_base_url(config),
                &window,
                &config.live_caption_language,
            )),
            _ => Err(anyhow!("不支援的即時字幕轉錄後端：{}", backend)),
        };

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
                emit_error(app, format!("單段即時字幕轉錄失敗，將繼續處理：{}", error));
                continue;
            }
        };
        let text = remove_overlap(&previous_text, &transcription);
        if text.trim().is_empty() {
            println!("[live-caption] 與前段完全重疊，略過");
            continue;
        }
        previous_text = transcription;

        sequence += 1;
        let display_text = build_display_text(&text, None, &config.live_caption_display_mode);
        let _ = app.emit(
            LIVE_CAPTION_EVENT,
            LiveCaptionPayload {
                sequence,
                original: text.clone(),
                translation: None,
                display_text,
            },
        );

        // 翻譯不得阻塞下一段 ASR；完成後用相同 sequence 更新已顯示的字幕。
        if config.live_caption_translate && config.live_caption_display_mode != "original" {
            let translation_app = app.clone();
            let translation_config = config.clone();
            let translation_text = text.clone();
            let translation_sequence = sequence;
            let translation_mode = config.live_caption_display_mode.clone();
            let translation_failure_reported = translation_failure_reported.clone();
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
        }
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
    // 即時字幕的視窗遠短於 Whisper 原生的 30 秒設計，短片段的信心分數天生偏低，
    // 沿用長音檔的預設門檻會把正常語音一併濾掉，故此處放寬三項門檻，
    // 幻覺改由 is_hallucination 的字串比對把關。
    params.set_logprob_thold(-2.0);
    params.set_no_speech_thold(0.9);
    params.set_entropy_thold(3.2);
    state
        .full(params, samples)
        .context("Whisper 即時推論失敗")?;

    let segment_count = state.full_n_segments();
    println!("[live-caption] Whisper 段落數={}", segment_count);
    let mut text = String::new();
    for index in 0..segment_count {
        text.push_str(
            &state
                .get_segment(index)
                .ok_or_else(|| anyhow!("無法讀取 Whisper 段落"))?
                .to_str()
                .context("無法讀取 Whisper 轉錄文字")?,
        );
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

fn drain_queue(queue: &SharedQueue, target: &mut VecDeque<f32>) {
    if let Ok(mut source) = queue.lock() {
        target.extend(source.drain(..));
    }
}

fn take_error(error_state: &SharedError) -> Option<anyhow::Error> {
    error_state
        .lock()
        .ok()
        .and_then(|mut error| error.take())
        .map(|message| anyhow!("{}", message))
}

fn remove_overlap(previous: &str, current: &str) -> String {
    if previous.is_empty() {
        return current.trim().to_string();
    }
    let normalized_previous: String = previous
        .chars()
        .filter(|char| char.is_alphanumeric())
        .collect();
    let normalized_current: String = current
        .chars()
        .filter(|char| char.is_alphanumeric())
        .collect();
    if normalized_previous.chars().count() >= 4 && normalized_previous == normalized_current {
        return String::new();
    }
    let previous_chars: Vec<char> = previous
        .chars()
        .filter(|char| !char.is_whitespace())
        .collect();
    let current_chars: Vec<char> = current.chars().collect();
    let compact_current: Vec<char> = current_chars
        .iter()
        .copied()
        .filter(|char| !char.is_whitespace())
        .collect();
    let max_overlap = previous_chars.len().min(compact_current.len()).min(120);
    for overlap in (8..=max_overlap).rev() {
        if previous_chars[previous_chars.len() - overlap..] == compact_current[..overlap] {
            let mut compact_seen = 0;
            for (index, char) in current_chars.iter().enumerate() {
                if !char.is_whitespace() {
                    compact_seen += 1;
                }
                if compact_seen == overlap {
                    return current_chars[index + 1..]
                        .iter()
                        .collect::<String>()
                        .trim()
                        .to_string();
                }
            }
        }
    }
    current.trim().to_string()
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

                let inside = cursor.x >= left
                    && cursor.x <= right
                    && cursor.y >= top
                    && cursor.y <= bottom;
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
    use super::{build_display_text, is_hallucination, remove_overlap};

    #[test]
    fn repeated_short_caption_is_not_emitted_again() {
        assert_eq!(remove_overlap("字幕製作：貝爾", "（字幕製作：貝爾）"), "");
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
}
