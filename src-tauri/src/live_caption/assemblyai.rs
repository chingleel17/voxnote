use anyhow::{anyhow, Result};
use futures_util::{future::BoxFuture, FutureExt, SinkExt, StreamExt};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest, http::header::AUTHORIZATION, http::HeaderValue, Message,
    },
    MaybeTlsStream, WebSocketStream,
};

const ASSEMBLYAI_STREAMING_ENDPOINT: &str = "wss://streaming.assemblyai.com/v3/ws";
const AUDIO_FRAME_SAMPLES: usize = 1_600;
const MIN_AUDIO_FRAME_SAMPLES: usize = 800;
const MAX_PENDING_SAMPLES: usize = 32_000;
const DROP_NOTICE_THROTTLE: std::time::Duration = std::time::Duration::from_secs(5);
const AUDIO_SEND_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
const AUDIO_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
const FORMATTING_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CaptionPhase {
    Partial,
    Final,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct TurnCaptionUpdate {
    pub turn_order: u64,
    pub revision: u64,
    pub text: String,
    pub phase: CaptionPhase,
    pub words: Option<serde_json::Value>,
}

type PostprocessFuture = BoxFuture<'static, (u64, String, Result<String>)>;

#[derive(Debug, Default)]
pub(super) struct TurnReducer {
    turns: HashMap<u64, TurnState>,
}

#[derive(Debug, Default)]
struct TurnState {
    final_text: Option<String>,
    formatting_started_at: Option<std::time::Instant>,
    revision: u64,
}

impl TurnReducer {
    pub fn apply(
        &mut self,
        event: ServerEvent,
        now: std::time::Instant,
    ) -> Result<Option<TurnCaptionUpdate>> {
        let ServerEvent::Turn {
            turn_order,
            transcript,
            end_of_turn,
            turn_is_formatted,
            words,
        } = event
        else {
            return Ok(None);
        };
        if transcript.trim().is_empty() {
            return Ok(None);
        }
        let state = self.turns.entry(turn_order).or_default();
        if state.final_text.is_some() {
            return Ok(None);
        }
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        let display_text = crate::asr::to_taiwan_traditional(&transcript)?;
        if end_of_turn {
            match turn_is_formatted {
                Some(true) => {
                    state.final_text = Some(display_text.clone());
                    state.formatting_started_at = None;
                    return Ok(Some(TurnCaptionUpdate {
                        turn_order,
                        revision,
                        text: display_text,
                        phase: CaptionPhase::Final,
                        words,
                    }));
                }
                Some(false) => {
                    let started = *state.formatting_started_at.get_or_insert(now);
                    if now.duration_since(started) >= FORMATTING_WAIT {
                        return Err(anyhow!("AssemblyAI 格式化完成逾時，模型不相容"));
                    }
                }
                None => return Err(anyhow!("AssemblyAI 完成 Turn 缺少格式化狀態")),
            }
        }
        Ok(Some(TurnCaptionUpdate {
            turn_order,
            revision,
            text: display_text,
            phase: CaptionPhase::Partial,
            words,
        }))
    }

    pub fn check_formatting_deadlines(&self, now: std::time::Instant) -> Result<()> {
        if self.turns.values().any(|state| {
            state.final_text.is_none()
                && state
                    .formatting_started_at
                    .is_some_and(|started| now.duration_since(started) >= FORMATTING_WAIT)
        }) {
            return Err(anyhow!("AssemblyAI 格式化完成逾時，模型不相容"));
        }
        Ok(())
    }
}

pub(super) async fn run_stream_session(
    app: AppHandle,
    config: crate::config::AppConfig,
    session_id: String,
    audio_source: String,
    queue: crate::audio_recording::SharedQueue,
    running: Arc<AtomicBool>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    let mut capture_pump = QueuePump::start(queue.clone());
    let connection = build_connection_config(
        &config.assembly_ai_key,
        &config.live_caption_assemblyai_model,
        &config.live_caption_language,
    )?;
    let connector = TlsWebSocketConnector;
    let mut socket =
        connect_and_wait_for_begin(&connector, &connection, &running, Duration::from_secs(10))
            .await?;
    let _ = app.emit(
        super::LIVE_CAPTION_STATUS_EVENT,
        super::LiveCaptionStatus {
            active: true,
            backend: Some("assemblyai_streaming".into()),
            audio_source: Some(audio_source),
            session_id: Some(session_id.clone()),
        },
    );
    ready_tx
        .send(Ok(()))
        .map_err(|_| anyhow!("即時字幕啟動狀態無法回傳"))?;

    let mut last_sent_at = None;
    let mut last_server_frame_at = Instant::now();
    let session_started_at = Instant::now();
    let mut reducer = TurnReducer::default();
    let mut postprocess_pending: VecDeque<PostprocessFuture> = VecDeque::new();
    let mut postprocess_running = futures_util::stream::FuturesUnordered::new();
    let mut stopping = false;
    loop {
        if !running.load(Ordering::SeqCst) || stop_rx.try_recv().is_ok() {
            stopping = true;
            break;
        }
        if session_started_at.elapsed() >= Duration::from_secs(180 * 60) {
            super::emit_error(&app, "即時字幕已達 180 分鐘上限，連線正在停止".into());
            stopping = true;
            break;
        }
        if last_server_frame_at.elapsed() >= Duration::from_secs(15) {
            return Err(anyhow!("AssemblyAI 連線 15 秒內沒有收到服務訊息"));
        }
        reducer.check_formatting_deadlines(Instant::now())?;
        while postprocess_running.len() < 2 {
            let Some(work) = postprocess_pending.pop_front() else {
                break;
            };
            postprocess_running.push(work);
        }
        if let Some(Some((turn_order, original, result))) =
            postprocess_running.next().now_or_never()
        {
            match result {
                Ok(value) if !value.trim().is_empty() && running.load(Ordering::SeqCst) => {
                    let value = value.trim().to_string();
                    let is_translation = config.live_caption_language != "zh"
                        && config.live_caption_translate
                        && config.live_caption_display_mode != "original";
                    let revision = reducer
                        .turns
                        .get(&turn_order)
                        .map(|turn| turn.revision.saturating_add(1))
                        .unwrap_or(1);
                    let display_text = if is_translation {
                        super::build_display_text(
                            &original,
                            Some(&value),
                            &config.live_caption_display_mode,
                        )
                    } else {
                        value.clone()
                    };
                    let _ = app.emit(
                        super::LIVE_CAPTION_EVENT,
                        super::LiveCaptionPayload {
                            session_id: session_id.clone(),
                            sequence: turn_order.saturating_add(1),
                            revision,
                            phase: "postprocessed".into(),
                            original: if is_translation {
                                original.clone()
                            } else {
                                value.clone()
                            },
                            translation: is_translation.then_some(value.clone()),
                            display_text,
                            confirmed_text: if is_translation { original } else { value },
                            tentative_text: String::new(),
                            is_tentative: false,
                        },
                    );
                }
                Ok(_) => {}
                Err(error) => super::emit_error(&app, format!("字幕後處理失敗，保留原文：{error}")),
            }
            continue;
        }
        if capture_pump.take_drop_notice() {
            super::emit_error(&app, "串流音訊超過佇列上限，已捨棄較舊音訊".into());
        }

        if remaining_audio_cadence(last_sent_at, Instant::now()).is_zero() {
            if let Some(frame) = capture_pump.take_frame() {
                send_frame_cancellable(socket.as_mut(), frame, &running).await?;
                last_sent_at = Some(Instant::now());
                continue;
            }
        }

        match tokio::time::timeout(Duration::from_millis(25), socket.receive()).await {
            Ok(Ok(ServerFrame::Text(text))) => {
                last_server_frame_at = Instant::now();
                match parse_server_event(&text, &connection.authorization)? {
                    ServerEvent::Turn { .. } => {
                        let event = parse_server_event(&text, &connection.authorization)?;
                        if let Some(update) = reducer.apply(event, Instant::now())? {
                            let sequence = update.turn_order.saturating_add(1);
                            let is_tentative = update.phase == CaptionPhase::Partial;
                            let display_text = update.text.clone();
                            let _ = app.emit(
                                super::LIVE_CAPTION_EVENT,
                                super::LiveCaptionPayload {
                                    session_id: session_id.clone(),
                                    sequence,
                                    revision: update.revision,
                                    phase: if is_tentative { "partial" } else { "final" }.into(),
                                    original: update.text.clone(),
                                    translation: None,
                                    display_text,
                                    confirmed_text: if is_tentative {
                                        String::new()
                                    } else {
                                        update.text.clone()
                                    },
                                    tentative_text: if is_tentative {
                                        update.text.clone()
                                    } else {
                                        String::new()
                                    },
                                    is_tentative,
                                },
                            );
                            if update.phase == CaptionPhase::Final {
                                if let Some(work) = make_postprocess_future(
                                    config.clone(),
                                    update.turn_order,
                                    update.text,
                                ) {
                                    if postprocess_pending.len() >= 8 {
                                        postprocess_pending.pop_front();
                                        super::emit_error(
                                            &app,
                                            "字幕後處理佇列已滿，略過較舊工作並保留原文".into(),
                                        );
                                    }
                                    postprocess_pending.push_back(work);
                                }
                            }
                        }
                    }
                    ServerEvent::Error { message } => return Err(anyhow!("{message}")),
                    ServerEvent::Termination => break,
                    _ => {}
                }
            }
            Ok(Ok(ServerFrame::Ping(_))) => last_server_frame_at = Instant::now(),
            Ok(Ok(ServerFrame::Closed)) => return Err(anyhow!("AssemblyAI 串流連線已關閉")),
            Ok(Err(error)) => return Err(error),
            Err(_) => {}
        }
    }

    if stopping {
        running.store(false, Ordering::SeqCst);
        postprocess_pending.clear();
        postprocess_running.clear();
        for tail in capture_pump.stop_and_take_frames(&queue) {
            let _ = tokio::time::timeout(AUDIO_WRITE_TIMEOUT, socket.send_binary(tail)).await;
        }
        let _ = tokio::time::timeout(
            AUDIO_WRITE_TIMEOUT,
            socket.send_text(r#"{"type":"Terminate"}"#.into()),
        )
        .await;
        let termination_deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < termination_deadline {
            match tokio::time::timeout(Duration::from_millis(100), socket.receive()).await {
                Ok(Ok(ServerFrame::Text(text)))
                    if matches!(
                        parse_server_event(&text, &connection.authorization),
                        Ok(ServerEvent::Termination)
                    ) =>
                {
                    break
                }
                Ok(Ok(ServerFrame::Closed)) | Ok(Err(_)) => break,
                _ => {}
            }
        }
    }
    Ok(())
}

async fn connect_and_wait_for_begin(
    connector: &dyn StreamingConnector,
    connection: &AssemblyAiConnectionConfig,
    running: &AtomicBool,
    startup_timeout: Duration,
) -> Result<Box<dyn StreamingSocket>> {
    if !running.load(Ordering::SeqCst) {
        return Err(anyhow!("AssemblyAI 串流啟動已取消"));
    }
    let startup_deadline = Instant::now() + startup_timeout;
    let mut socket = tokio::select! {
        result = tokio::time::timeout(
            startup_deadline.saturating_duration_since(Instant::now()),
            connector.connect(&connection.url, &connection.authorization),
        ) => result.map_err(|_| anyhow!("AssemblyAI 串流啟動逾時"))??,
        _ = wait_for_stop(running) => return Err(anyhow!("AssemblyAI 串流啟動已取消")),
    };

    loop {
        if !running.load(Ordering::SeqCst) {
            return Err(anyhow!("AssemblyAI 串流啟動已取消"));
        }
        let remaining = startup_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(anyhow!("等待 AssemblyAI Begin 逾時"));
        }
        let received = tokio::select! {
            result = tokio::time::timeout(remaining, socket.receive()) => result,
            _ = wait_for_stop(running) => return Err(anyhow!("AssemblyAI 串流啟動已取消")),
        };
        match received {
            Ok(Ok(ServerFrame::Text(text))) => {
                let event = parse_server_event(&text, &connection.authorization)?;
                match event {
                    ServerEvent::Begin { .. } => {
                        validate_begin_model(&event, &connection.model)?;
                        return Ok(socket);
                    }
                    ServerEvent::Error { message } => return Err(anyhow!("{message}")),
                    _ => return Err(anyhow!("AssemblyAI Begin 前收到非預期事件")),
                }
            }
            Ok(Ok(ServerFrame::Ping(_))) => continue,
            Ok(Ok(ServerFrame::Closed)) => return Err(anyhow!("AssemblyAI 在 Begin 前關閉連線")),
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(anyhow!("等待 AssemblyAI Begin 逾時")),
        }
    }
}

fn make_postprocess_future(
    config: crate::config::AppConfig,
    turn_order: u64,
    original: String,
) -> Option<PostprocessFuture> {
    let (should_translate, should_proofread) = super::resolve_translate_or_proofread(
        config.live_caption_translate,
        config.live_caption_proofread,
        &config.live_caption_display_mode,
        &config.live_caption_language,
    );
    if !should_translate && !should_proofread {
        return None;
    }
    let system_prompt = if should_translate {
        "你是即時字幕翻譯員。請將輸入內容翻譯成自然、簡潔的繁體中文台灣用語。只輸出譯文，不要加註解、前綴或引號。"
    } else {
        super::PROOFREAD_CORE_SYSTEM
    };
    Some(Box::pin(async move {
        let result = super::call_llm(&config, system_prompt, &original).await;
        (turn_order, original, result)
    }))
}

#[derive(Default)]
struct CaptureBufferState {
    accepting: bool,
    audio: BoundedAudioQueue,
    drop_notice_pending: bool,
}

struct QueuePump {
    running: Arc<AtomicBool>,
    state: Arc<std::sync::Mutex<CaptureBufferState>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl QueuePump {
    fn start(source: crate::audio_recording::SharedQueue) -> Self {
        let running = Arc::new(AtomicBool::new(true));
        let state = Arc::new(std::sync::Mutex::new(CaptureBufferState {
            accepting: true,
            audio: BoundedAudioQueue::default(),
            drop_notice_pending: false,
        }));
        let thread_running = running.clone();
        let thread_state = state.clone();
        let handle = thread::spawn(move || {
            while thread_running.load(Ordering::SeqCst) {
                let captured = source
                    .lock()
                    .map(|mut source| source.drain(..).collect::<Vec<_>>())
                    .unwrap_or_default();
                if !captured.is_empty() {
                    if let Ok(mut state) = thread_state.lock() {
                        if state.accepting && state.audio.push(captured, Instant::now()) {
                            state.drop_notice_pending = true;
                        }
                    }
                }
                thread::sleep(Duration::from_millis(10));
            }
        });
        Self {
            running,
            state,
            handle: Some(handle),
        }
    }

    fn take_frame(&self) -> Option<Vec<u8>> {
        self.state.lock().ok()?.audio.take_frame()
    }

    fn take_drop_notice(&self) -> bool {
        self.state
            .lock()
            .map(|mut state| std::mem::take(&mut state.drop_notice_pending))
            .unwrap_or(false)
    }

    fn stop_and_take_frames(
        &mut self,
        source: &crate::audio_recording::SharedQueue,
    ) -> Vec<Vec<u8>> {
        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        state.accepting = false;
        if let Ok(mut source) = source.lock() {
            let captured = source.drain(..).collect::<Vec<_>>();
            state.audio.push(captured, Instant::now());
        }
        self.running.store(false, Ordering::SeqCst);
        state.audio.take_shutdown_frames()
    }
}

impl Drop for QueuePump {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        if let Ok(mut state) = self.state.lock() {
            state.accepting = false;
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

async fn wait_for_stop(running: &AtomicBool) {
    while running.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[derive(Debug, Default)]
pub(super) struct BoundedAudioQueue {
    samples: VecDeque<f32>,
    last_drop_notice: Option<std::time::Instant>,
}

impl BoundedAudioQueue {
    pub fn push(
        &mut self,
        samples: impl IntoIterator<Item = f32>,
        now: std::time::Instant,
    ) -> bool {
        self.samples.extend(samples);
        let overflow = self.samples.len().saturating_sub(MAX_PENDING_SAMPLES);
        for _ in 0..overflow {
            self.samples.pop_front();
        }
        if overflow == 0 {
            return false;
        }
        let notify = self
            .last_drop_notice
            .map(|last| now.duration_since(last) >= DROP_NOTICE_THROTTLE)
            .unwrap_or(true);
        if notify {
            self.last_drop_notice = Some(now);
        }
        notify
    }

    pub fn take_frame(&mut self) -> Option<Vec<u8>> {
        if self.samples.len() < AUDIO_FRAME_SAMPLES {
            return None;
        }
        Some(encode_pcm16_le(
            &self
                .samples
                .drain(..AUDIO_FRAME_SAMPLES)
                .collect::<Vec<_>>(),
        ))
    }

    pub fn take_shutdown_frames(&mut self) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        const MAX_FRAME_SAMPLES: usize = 16_000;
        while self.samples.len() > MAX_FRAME_SAMPLES {
            let frame: Vec<f32> = self.samples.drain(..MAX_FRAME_SAMPLES).collect();
            frames.push(encode_pcm16_le(&frame));
        }
        if !self.samples.is_empty() {
            let mut tail: Vec<f32> = self.samples.drain(..).collect();
            if tail.len() < MIN_AUDIO_FRAME_SAMPLES {
                tail.resize(MIN_AUDIO_FRAME_SAMPLES, 0.0);
            }
            frames.push(encode_pcm16_le(&tail));
        }
        frames
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.samples.len()
    }
}

fn remaining_audio_cadence(last_sent_at: Option<Instant>, now: Instant) -> Duration {
    last_sent_at
        .map(|sent| AUDIO_SEND_INTERVAL.saturating_sub(now.saturating_duration_since(sent)))
        .unwrap_or(Duration::ZERO)
}

pub(super) async fn send_frame_cancellable(
    socket: &mut dyn StreamingSocket,
    bytes: Vec<u8>,
    running: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    use std::sync::atomic::Ordering;
    tokio::select! {
        result = tokio::time::timeout(AUDIO_WRITE_TIMEOUT, socket.send_binary(bytes)) => {
            result.map_err(|_| anyhow!("AssemblyAI 音訊寫入逾時"))?
        }
        _ = async {
            while running.load(Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        } => Err(anyhow!("AssemblyAI 音訊寫入已取消")),
    }
}

pub(super) fn encode_pcm16_le(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let value = if !sample.is_finite() {
            0
        } else if *sample <= -1.0 {
            i16::MIN
        } else if *sample >= 1.0 {
            i16::MAX
        } else {
            (sample * i16::MAX as f32).round() as i16
        };
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct AssemblyAiConnectionConfig {
    pub url: String,
    pub authorization: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ServerFrame {
    Text(String),
    Ping(Vec<u8>),
    Closed,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum ServerEvent {
    Begin {
        model: Option<String>,
    },
    Turn {
        turn_order: u64,
        transcript: String,
        end_of_turn: bool,
        turn_is_formatted: Option<bool>,
        words: Option<serde_json::Value>,
    },
    Termination,
    Error {
        message: String,
    },
    Ignore,
}

pub(super) fn parse_server_event(text: &str, api_key: &str) -> Result<ServerEvent> {
    let event: serde_json::Value =
        serde_json::from_str(text).map_err(|_| anyhow!("AssemblyAI 傳回無效 JSON 事件"))?;
    let event_type = event
        .get("type")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| anyhow!("AssemblyAI 事件缺少 type 欄位"))?;
    match event_type {
        "Begin" => Ok(ServerEvent::Begin {
            model: event
                .get("configuration")
                .and_then(|value| value.get("speech_model").or_else(|| value.get("model")))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        }),
        "Turn" => {
            let turn_order = event
                .get("turn_order")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| anyhow!("AssemblyAI Turn 缺少有效 turn_order"))?;
            let transcript = event
                .get("transcript")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| anyhow!("AssemblyAI Turn 缺少有效 transcript"))?
                .to_string();
            let end_of_turn = event
                .get("end_of_turn")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(|| anyhow!("AssemblyAI Turn 缺少有效 end_of_turn"))?;
            let turn_is_formatted = match event.get("turn_is_formatted") {
                Some(value) => Some(
                    value
                        .as_bool()
                        .ok_or_else(|| anyhow!("AssemblyAI Turn 的 turn_is_formatted 型別錯誤"))?,
                ),
                None if end_of_turn && !transcript.trim().is_empty() => {
                    return Err(anyhow!("AssemblyAI 完成 Turn 缺少 turn_is_formatted"));
                }
                None => None,
            };
            Ok(ServerEvent::Turn {
                turn_order,
                transcript,
                end_of_turn,
                turn_is_formatted,
                words: event.get("words").cloned(),
            })
        }
        "Termination" => Ok(ServerEvent::Termination),
        "Error" => {
            let message = event
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("AssemblyAI 服務回報錯誤")
                .replace(api_key, "[已遮蔽]");
            Ok(ServerEvent::Error { message })
        }
        // Heartbeat 及後續新增的非必要事件不視為字幕或錯誤。
        "Heartbeat" | "Ping" | "Pong" => Ok(ServerEvent::Ignore),
        _ => Ok(ServerEvent::Ignore),
    }
}

pub(super) fn validate_begin_model(event: &ServerEvent, expected_model: &str) -> Result<()> {
    match event {
        ServerEvent::Begin { model: Some(model) } if model == expected_model => Ok(()),
        ServerEvent::Begin { model: Some(_) } => {
            Err(anyhow!("AssemblyAI Begin 回報的模型與請求不一致"))
        }
        ServerEvent::Begin { model: None } => Err(anyhow!("AssemblyAI Begin 缺少模型識別")),
        _ => Err(anyhow!("等待 AssemblyAI Begin 時收到非 Begin 事件")),
    }
}

pub(super) trait StreamingSocket: Send {
    fn send_binary<'a>(&'a mut self, bytes: Vec<u8>) -> BoxFuture<'a, Result<()>>;
    fn send_text<'a>(&'a mut self, text: String) -> BoxFuture<'a, Result<()>>;
    fn receive<'a>(&'a mut self) -> BoxFuture<'a, Result<ServerFrame>>;
}

pub(super) trait StreamingConnector: Send + Sync {
    fn connect<'a>(
        &'a self,
        url: &'a str,
        authorization: &'a str,
    ) -> BoxFuture<'a, Result<Box<dyn StreamingSocket>>>;
}

#[derive(Default)]
pub(super) struct TlsWebSocketConnector;

impl StreamingConnector for TlsWebSocketConnector {
    fn connect<'a>(
        &'a self,
        url: &'a str,
        authorization: &'a str,
    ) -> BoxFuture<'a, Result<Box<dyn StreamingSocket>>> {
        Box::pin(async move {
            let mut request = url
                .into_client_request()
                .map_err(|error| anyhow!("AssemblyAI WebSocket URL 無效：{error}"))?;
            let authorization = HeaderValue::from_str(authorization)
                .map_err(|_| anyhow!("AssemblyAI API Key 格式無效"))?;
            request.headers_mut().insert(AUTHORIZATION, authorization);
            let (socket, _) = connect_async(request)
                .await
                .map_err(|_| anyhow!("AssemblyAI WebSocket 連線失敗，請檢查網路與認證設定"))?;
            Ok(Box::new(TlsStreamingSocket { socket }) as Box<dyn StreamingSocket>)
        })
    }
}

struct TlsStreamingSocket {
    socket: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
}

impl StreamingSocket for TlsStreamingSocket {
    fn send_binary<'a>(&'a mut self, bytes: Vec<u8>) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.socket
                .send(Message::binary(bytes))
                .await
                .map_err(|error| anyhow!("AssemblyAI 音訊傳送失敗：{error}"))
        })
    }

    fn send_text<'a>(&'a mut self, text: String) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.socket
                .send(Message::text(text))
                .await
                .map_err(|error| anyhow!("AssemblyAI 控制訊息傳送失敗：{error}"))
        })
    }

    fn receive<'a>(&'a mut self) -> BoxFuture<'a, Result<ServerFrame>> {
        Box::pin(async move {
            loop {
                match self.socket.next().await {
                    Some(Ok(Message::Text(text))) => {
                        return Ok(ServerFrame::Text(text.to_string()))
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let payload = payload.to_vec();
                        self.socket
                            .send(Message::Pong(payload.clone().into()))
                            .await
                            .map_err(|error| anyhow!("AssemblyAI Pong 傳送失敗：{error}"))?;
                        return Ok(ServerFrame::Ping(payload));
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(ServerFrame::Closed),
                    Some(Ok(Message::Binary(_))) | Some(Ok(Message::Pong(_))) => continue,
                    Some(Err(error)) => {
                        return Err(anyhow!("AssemblyAI WebSocket 讀取失敗：{error}"))
                    }
                    _ => continue,
                }
            }
        })
    }
}

#[derive(Serialize)]
struct ConnectionParameters<'a> {
    sample_rate: u32,
    encoding: &'static str,
    speech_model: &'a str,
    language_detection: bool,
    session_heartbeat: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    language_codes: Option<Vec<&'a str>>,
}

pub(super) fn build_connection_config(
    api_key: &str,
    model: &str,
    language: &str,
) -> Result<AssemblyAiConnectionConfig> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(anyhow!("AssemblyAI API Key 未設定"));
    }
    let model = model.trim();
    if model.is_empty() {
        return Err(anyhow!("AssemblyAI 即時串流模型未設定"));
    }

    let language_codes = match language {
        "auto" | "" => None,
        "zh" => Some(vec!["zh"]),
        "en" => Some(vec!["en"]),
        other => return Err(anyhow!("AssemblyAI 串流不支援此來源語言：{other}")),
    };
    let parameters = ConnectionParameters {
        sample_rate: 16_000,
        encoding: "pcm_s16le",
        speech_model: model,
        language_detection: true,
        session_heartbeat: true,
        language_codes,
    };
    let query = serde_json::to_value(parameters)?;
    let query = query
        .as_object()
        .ok_or_else(|| anyhow!("無法建立 AssemblyAI 串流參數"))?
        .iter()
        .map(|(key, value)| {
            let value = match value {
                serde_json::Value::String(value) => value.clone(),
                _ => value.to_string(),
            };
            format!("{}={}", percent_encode(key), percent_encode(&value))
        })
        .collect::<Vec<_>>()
        .join("&");

    Ok(AssemblyAiConnectionConfig {
        url: format!("{ASSEMBLYAI_STREAMING_ENDPOINT}?{query}"),
        authorization: api_key.to_string(),
        model: model.to_string(),
    })
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::{
        build_connection_config, connect_and_wait_for_begin, encode_pcm16_le, parse_server_event,
        remaining_audio_cadence, send_frame_cancellable, validate_begin_model, BoundedAudioQueue,
        CaptionPhase, ServerEvent, ServerFrame, StreamingConnector, StreamingSocket,
        TlsWebSocketConnector, TurnReducer, AUDIO_WRITE_TIMEOUT,
    };
    use futures_util::SinkExt;
    use std::collections::VecDeque;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };

    #[test]
    fn auto_language_is_omitted_and_key_stays_out_of_url() {
        let config = build_connection_config("secret-key", "custom/model v1", "auto")
            .expect("應建立串流連線設定");

        assert!(config
            .url
            .starts_with("wss://streaming.assemblyai.com/v3/ws?"));
        assert!(config.url.contains("speech_model=custom%2Fmodel%20v1"));
        assert!(!config.url.contains("language_codes"));
        assert!(!config.url.contains("secret-key"));
        assert_eq!(config.authorization, "secret-key");
        assert_eq!(config.model, "custom/model v1");
    }

    #[test]
    fn explicit_language_is_a_json_array_query_value() {
        let config = build_connection_config("key", "universal-3-6-pro", "zh")
            .expect("應建立中文串流連線設定");

        assert!(config.url.contains("language_codes=%5B%22zh%22%5D"));
        assert!(config.url.contains("language_detection=true"));
        assert!(config.url.contains("encoding=pcm_s16le"));
    }

    #[test]
    fn batch_model_is_not_used_as_stream_model() {
        let config =
            build_connection_config("key", "stream-model", "en").expect("應接受手動指定模型");

        assert_eq!(config.model, "stream-model");
        assert!(config.url.contains("speech_model=stream-model"));
        assert!(config.url.contains("language_codes=%5B%22en%22%5D"));
    }

    #[tokio::test]
    async fn connects_to_injected_local_websocket_and_sends_authorization_header() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("本機 mock listener 應可啟動");
        let address = listener.local_addr().expect("應取得本機位址");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("應接受 WebSocket 連線");
            let mut socket = accept_hdr_async(stream, |request: &Request, response: Response| {
                assert_eq!(
                    request
                        .headers()
                        .get("authorization")
                        .and_then(|v| v.to_str().ok()),
                    Some("mock-test-key")
                );
                Ok(response)
            })
            .await
            .expect("應完成 mock handshake");
            socket
                .send(tokio_tungstenite::tungstenite::Message::text(
                    r#"{"type":"Begin","id":"mock-session"}"#,
                ))
                .await
                .expect("應送出 mock Begin");
        });

        let mut socket = TlsWebSocketConnector
            .connect(&format!("ws://{address}"), "mock-test-key")
            .await
            .expect("應連至注入的本機 WebSocket");
        assert_eq!(
            socket.receive().await.expect("應接收 mock Begin"),
            super::ServerFrame::Text(r#"{"type":"Begin","id":"mock-session"}"#.into())
        );
        server.await.expect("mock server 應正常結束");
    }

    struct MockSocket {
        frames: VecDeque<ServerFrame>,
        dropped: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Drop for MockSocket {
        fn drop(&mut self) {
            self.dropped
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl StreamingSocket for MockSocket {
        fn send_binary<'a>(
            &'a mut self,
            _bytes: Vec<u8>,
        ) -> futures_util::future::BoxFuture<'a, anyhow::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn send_text<'a>(
            &'a mut self,
            _text: String,
        ) -> futures_util::future::BoxFuture<'a, anyhow::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn receive<'a>(
            &'a mut self,
        ) -> futures_util::future::BoxFuture<'a, anyhow::Result<ServerFrame>> {
            Box::pin(async move {
                match self.frames.pop_front() {
                    Some(frame) => Ok(frame),
                    None => std::future::pending().await,
                }
            })
        }
    }

    struct MockConnector {
        frames: VecDeque<ServerFrame>,
        connect_calls: Arc<std::sync::atomic::AtomicUsize>,
        dropped: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl StreamingConnector for MockConnector {
        fn connect<'a>(
            &'a self,
            _url: &'a str,
            _authorization: &'a str,
        ) -> futures_util::future::BoxFuture<'a, anyhow::Result<Box<dyn StreamingSocket>>> {
            self.connect_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let frames = self.frames.clone();
            let dropped = self.dropped.clone();
            Box::pin(async move { Ok(Box::new(MockSocket { frames, dropped }) as _) })
        }
    }

    #[tokio::test]
    async fn startup_rejects_model_mismatch_and_drops_the_socket() {
        let config = build_connection_config("key", "expected-model", "auto").expect("應建立設定");
        let dropped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let connector = MockConnector {
            frames: VecDeque::from([ServerFrame::Text(
                r#"{"type":"Begin","configuration":{"model":"other-model"}}"#.into(),
            )]),
            connect_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            dropped: dropped.clone(),
        };
        let running = std::sync::atomic::AtomicBool::new(true);

        assert!(
            connect_and_wait_for_begin(&connector, &config, &running, Duration::from_secs(1),)
                .await
                .is_err()
        );
        assert_eq!(dropped.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn startup_cancellation_and_missing_key_do_not_open_a_socket() {
        let config = build_connection_config("key", "model", "auto").expect("應建立設定");
        let connect_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let connector = MockConnector {
            frames: VecDeque::new(),
            connect_calls: connect_calls.clone(),
            dropped: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        let running = std::sync::atomic::AtomicBool::new(false);

        assert!(
            connect_and_wait_for_begin(&connector, &config, &running, Duration::from_secs(1),)
                .await
                .is_err()
        );
        assert_eq!(connect_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(build_connection_config("", "model", "auto").is_err());
    }

    #[tokio::test]
    async fn startup_requires_begin_before_deadline() {
        let config = build_connection_config("key", "model", "auto").expect("應建立設定");
        let dropped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let connector = MockConnector {
            frames: VecDeque::new(),
            connect_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            dropped: dropped.clone(),
        };
        let running = std::sync::atomic::AtomicBool::new(true);

        assert!(connect_and_wait_for_begin(
            &connector,
            &config,
            &running,
            Duration::from_millis(20),
        )
        .await
        .is_err());
        assert_eq!(dropped.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn startup_returns_only_after_begin_confirms_the_requested_model() {
        let config = build_connection_config("key", "model", "auto").expect("應建立設定");
        let dropped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let connector = MockConnector {
            frames: VecDeque::from([ServerFrame::Text(
                r#"{"type":"Begin","configuration":{"model":"model"}}"#.into(),
            )]),
            connect_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            dropped: dropped.clone(),
        };
        let running = std::sync::atomic::AtomicBool::new(true);
        let socket =
            connect_and_wait_for_begin(&connector, &config, &running, Duration::from_secs(1))
                .await
                .expect("有效 Begin 後應回傳連線");

        drop(socket);
        assert_eq!(dropped.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn pcm_conversion_handles_endpoints_saturation_and_non_finite_values() {
        let bytes = encode_pcm16_le(&[-1.0, 1.0, -2.0, 2.0, f32::NAN, f32::INFINITY]);
        let values: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();

        assert_eq!(values, [i16::MIN, i16::MAX, i16::MIN, i16::MAX, 0, 0]);
    }

    #[test]
    fn packetizer_emits_100ms_frames_and_pads_short_tail_to_50ms() {
        let mut packetizer = BoundedAudioQueue::default();
        packetizer.push(vec![0.25; 1_600], std::time::Instant::now());
        let frame = packetizer.take_frame().expect("應取出 100 ms 封包");
        assert_eq!(frame.len(), 3_200);
        assert!(packetizer.take_frame().is_none());

        packetizer.push(vec![0.5; 400], std::time::Instant::now());
        let frames = packetizer.take_shutdown_frames();
        assert_eq!(frames.len(), 1);
        let tail = &frames[0];
        assert_eq!(tail.len(), 1_600);
        assert!(tail[800..].iter().all(|byte| *byte == 0));
        assert!(packetizer.take_shutdown_frames().is_empty());
    }

    #[test]
    fn shutdown_backlog_is_split_into_protocol_sized_frames() {
        let mut queue = BoundedAudioQueue::default();
        queue.push(vec![0.1; 32_000], std::time::Instant::now());

        let frames = queue.take_shutdown_frames();

        assert_eq!(frames.len(), 2);
        assert!(frames.iter().all(|frame| frame.len() == 32_000));
    }

    #[test]
    fn bounded_queue_keeps_latest_two_seconds_and_throttles_drop_notices() {
        let now = std::time::Instant::now();
        let mut queue = BoundedAudioQueue::default();
        assert!(queue.push(vec![0.1; 40_000], now));
        assert_eq!(queue.len(), 32_000);
        assert!(!queue.push(vec![0.2; 1], now + std::time::Duration::from_secs(4)));
        assert!(queue.push(vec![0.2; 1], now + std::time::Duration::from_secs(5)));
        assert_eq!(queue.len(), 32_000);
    }

    struct WaitingSocket;

    impl StreamingSocket for WaitingSocket {
        fn send_binary<'a>(
            &'a mut self,
            _bytes: Vec<u8>,
        ) -> futures_util::future::BoxFuture<'a, anyhow::Result<()>> {
            Box::pin(async { std::future::pending().await })
        }

        fn send_text<'a>(
            &'a mut self,
            _text: String,
        ) -> futures_util::future::BoxFuture<'a, anyhow::Result<()>> {
            Box::pin(async { Ok(()) })
        }

        fn receive<'a>(
            &'a mut self,
        ) -> futures_util::future::BoxFuture<'a, anyhow::Result<super::ServerFrame>> {
            Box::pin(async { Ok(super::ServerFrame::Closed) })
        }
    }

    #[tokio::test]
    async fn blocked_audio_write_is_cancelled() {
        let mut socket = WaitingSocket;
        let running = std::sync::atomic::AtomicBool::new(true);
        let cancel = async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            running.store(false, std::sync::atomic::Ordering::SeqCst);
        };
        let result = tokio::join!(
            send_frame_cancellable(&mut socket, vec![0; 3_200], &running),
            cancel
        )
        .0;
        assert!(result.is_err());
    }

    #[test]
    fn audio_cadence_never_fast_forwards_backlog() {
        let sent_at = Instant::now();
        assert_eq!(remaining_audio_cadence(None, sent_at), Duration::ZERO);
        assert_eq!(
            remaining_audio_cadence(Some(sent_at), sent_at + Duration::from_millis(30)),
            Duration::from_millis(70)
        );
        assert_eq!(
            remaining_audio_cadence(Some(sent_at), sent_at + Duration::from_millis(250)),
            Duration::ZERO
        );
    }

    #[tokio::test]
    async fn blocked_audio_write_hits_one_second_deadline() {
        let mut socket = WaitingSocket;
        let running = std::sync::atomic::AtomicBool::new(true);
        let started = Instant::now();
        let result = send_frame_cancellable(&mut socket, vec![0; 3_200], &running).await;
        assert!(result.is_err());
        assert!(started.elapsed() >= AUDIO_WRITE_TIMEOUT);
    }

    #[test]
    fn parses_server_events_preserves_words_and_redacts_service_errors() {
        let begin = parse_server_event(
            r#"{"type":"Begin","configuration":{"speech_model":"universal-3-6-pro"}}"#,
            "private-key",
        )
        .expect("Begin 應可解析");
        assert_eq!(
            begin,
            ServerEvent::Begin {
                model: Some("universal-3-6-pro".into())
            }
        );

        let turn = parse_server_event(
            r#"{"type":"Turn","turn_order":2,"transcript":"Hello","end_of_turn":false,"words":[{"text":"Hello","start":10,"end":20}]}"#,
            "private-key",
        )
        .expect("partial Turn 應可解析");
        assert!(matches!(
            turn,
            ServerEvent::Turn {
                turn_order: 2,
                end_of_turn: false,
                words: Some(_),
                ..
            }
        ));

        let error = parse_server_event(
            r#"{"type":"Error","error":"invalid private-key"}"#,
            "private-key",
        )
        .expect("Error 事件應可解析");
        assert_eq!(
            error,
            ServerEvent::Error {
                message: "invalid [已遮蔽]".into()
            }
        );
        assert_eq!(
            parse_server_event(r#"{"type":"Heartbeat"}"#, "key").expect("Heartbeat 應被忽略"),
            ServerEvent::Ignore
        );
    }

    #[test]
    fn rejects_malformed_required_turn_fields_but_ignores_unknown_events() {
        assert!(parse_server_event(
            r#"{"type":"Turn","turn_order":1,"transcript":"x","end_of_turn":true}"#,
            "key"
        )
        .is_err());
        assert!(parse_server_event(
            r#"{"type":"Turn","turn_order":1,"transcript":"x","end_of_turn":"yes"}"#,
            "key"
        )
        .is_err());
        assert_eq!(
            parse_server_event(r#"{"type":"FutureOptionalEvent"}"#, "key")
                .expect("未知事件應被忽略"),
            ServerEvent::Ignore
        );
        let begin = ServerEvent::Begin {
            model: Some("model-a".into()),
        };
        assert!(validate_begin_model(&begin, "model-b").is_err());
        assert!(validate_begin_model(&ServerEvent::Begin { model: None }, "model-a").is_err());
    }

    fn turn_event(order: u64, text: &str, end: bool, formatted: Option<bool>) -> ServerEvent {
        ServerEvent::Turn {
            turn_order: order,
            transcript: text.into(),
            end_of_turn: end,
            turn_is_formatted: formatted,
            words: Some(serde_json::json!([{ "text": "word", "start": 11, "end": 22 }])),
        }
    }

    #[test]
    fn turns_replace_in_place_preserve_word_times_and_ignore_after_final() {
        let now = std::time::Instant::now();
        let mut reducer = TurnReducer::default();
        let partial = reducer
            .apply(turn_event(1, "汉语 test", false, None), now)
            .expect("partial 應可處理")
            .expect("partial 應更新");
        assert_eq!(partial.text, "漢語 test");
        assert_eq!(partial.phase, CaptionPhase::Partial);
        assert_eq!(partial.words.as_ref().expect("保留 words")[0]["start"], 11);

        let final_update = reducer
            .apply(turn_event(1, "漢語 test。", true, Some(true)), now)
            .expect("final 應可處理")
            .expect("final 應更新");
        assert_eq!(final_update.phase, CaptionPhase::Final);
        assert!(reducer
            .apply(turn_event(1, "stale", false, None), now)
            .expect("final 後 stale partial 應忽略")
            .is_none());
        assert!(reducer
            .apply(turn_event(2, "漢語 test。", true, Some(true)), now)
            .expect("相同短句的新 turn 應保留")
            .is_some());
        assert!(reducer
            .apply(turn_event(3, "  ", true, Some(true)), now)
            .expect("空白 Turn 應抑制")
            .is_none());
    }

    #[test]
    fn unformatted_completion_waits_at_most_two_seconds() {
        let now = std::time::Instant::now();
        let mut reducer = TurnReducer::default();
        let waiting = reducer
            .apply(turn_event(5, "待格式化", true, Some(false)), now)
            .expect("期限內可等待")
            .expect("未格式化內容可作暫定顯示");
        assert_eq!(waiting.phase, CaptionPhase::Partial);
        assert!(reducer
            .check_formatting_deadlines(now + std::time::Duration::from_secs(1))
            .is_ok());
        assert!(reducer
            .check_formatting_deadlines(now + std::time::Duration::from_secs(2))
            .is_err());
        assert!(reducer
            .apply(
                turn_event(5, "待格式化", true, Some(false)),
                now + std::time::Duration::from_secs(2)
            )
            .is_err());
    }

    #[test]
    fn same_turn_revisions_replace_and_formatted_update_finalizes_once() {
        let now = std::time::Instant::now();
        let mut reducer = TurnReducer::default();
        let first = reducer
            .apply(turn_event(7, "第一版", false, None), now)
            .expect("第一版應可處理")
            .expect("第一版應顯示");
        let revised = reducer
            .apply(turn_event(7, "修正版", true, Some(false)), now)
            .expect("未格式化修正版可等待")
            .expect("修正版應覆寫顯示");
        assert_ne!(first.text, revised.text);
        assert_eq!(revised.phase, CaptionPhase::Partial);
        let final_update = reducer
            .apply(turn_event(7, "完成版", true, Some(true)), now)
            .expect("格式化完成可接受")
            .expect("應轉為 final");
        assert_eq!(final_update.text, "完成版");
        assert_eq!(final_update.phase, CaptionPhase::Final);
        assert!(reducer
            .apply(turn_event(7, "重複 final", true, Some(true)), now)
            .expect("重複 final 應忽略")
            .is_none());
    }

    #[test]
    fn caption_payload_serializes_session_revision_and_phase() {
        let payload = super::super::LiveCaptionPayload {
            session_id: "session-a".into(),
            sequence: 4,
            revision: 2,
            phase: "final".into(),
            original: "字幕".into(),
            translation: None,
            display_text: "字幕".into(),
            confirmed_text: "字幕".into(),
            tentative_text: String::new(),
            is_tentative: false,
        };
        let value = serde_json::to_value(payload).expect("字幕 payload 應可序列化");

        assert_eq!(value["session_id"], "session-a");
        assert_eq!(value["sequence"], 4);
        assert_eq!(value["revision"], 2);
        assert_eq!(value["phase"], "final");
    }
}
