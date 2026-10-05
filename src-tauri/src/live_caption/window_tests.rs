use super::*;
use std::collections::VecDeque;
use tokio::sync::oneshot;

#[derive(Default)]
struct RecordingSink {
    captions: Mutex<Vec<LiveCaptionPayload>>,
    changed: Condvar,
    errors: Mutex<Vec<String>>,
}

impl WindowEventSink for RecordingSink {
    fn caption(&self, payload: LiveCaptionPayload) {
        self.captions.lock().expect("字幕鎖").push(payload);
        self.changed.notify_all();
    }

    fn error(&self, message: String) {
        self.errors.lock().expect("錯誤鎖").push(message);
    }
}

impl RecordingSink {
    fn wait_for(&self, count: usize) -> Vec<LiveCaptionPayload> {
        let captions = self.captions.lock().expect("字幕鎖");
        let (captions, _) = self
            .changed
            .wait_timeout_while(captions, Duration::from_secs(6), |events| {
                events.len() < count
            })
            .expect("等待字幕事件");
        assert!(captions.len() >= count, "應收到 {count} 筆字幕事件");
        captions.clone()
    }

    fn snapshot(&self) -> Vec<LiveCaptionPayload> {
        self.captions.lock().expect("字幕鎖").clone()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DecodeCall {
    backend: String,
    incremental: bool,
    samples: usize,
    language: String,
}

struct ScriptDecoder {
    results: VecDeque<String>,
    calls: Arc<Mutex<Vec<DecodeCall>>>,
    block_at: Option<usize>,
    entered: Option<mpsc::Sender<()>>,
    resume: Option<mpsc::Receiver<()>>,
    after_at: Option<usize>,
    decoded: Option<mpsc::Sender<()>>,
    continue_after: Option<mpsc::Receiver<()>>,
}

impl ScriptDecoder {
    fn new(results: &[&str]) -> (Self, Arc<Mutex<Vec<DecodeCall>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                results: results.iter().map(|result| (*result).to_owned()).collect(),
                calls: calls.clone(),
                block_at: None,
                entered: None,
                resume: None,
                after_at: None,
                decoded: None,
                continue_after: None,
            },
            calls,
        )
    }

    fn block_at(&mut self, index: usize) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        self.block_at = Some(index);
        self.entered = Some(entered_tx);
        self.resume = Some(resume_rx);
        (entered_rx, resume_tx)
    }

    fn block_after(&mut self, index: usize) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (decoded_tx, decoded_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        self.after_at = Some(index);
        self.decoded = Some(decoded_tx);
        self.continue_after = Some(continue_rx);
        (decoded_rx, continue_tx)
    }
}

impl WindowDecoder for ScriptDecoder {
    fn decode(
        &mut self,
        backend: &str,
        incremental: bool,
        window: &[f32],
        config: &AppConfig,
    ) -> Result<String> {
        let count = {
            let mut calls = self.calls.lock().expect("解碼紀錄鎖");
            calls.push(DecodeCall {
                backend: backend.into(),
                incremental,
                samples: window.len(),
                language: config.live_caption_language.clone(),
            });
            calls.len()
        };
        let result = self.results.pop_front().unwrap_or_default();
        if self.block_at == Some(count) {
            if let Some(entered) = self.entered.take() {
                entered.send(()).expect("解碼已進入阻塞點");
            }
            if let Some(resume) = self.resume.take() {
                resume.recv().expect("解碼可恢復");
            }
        }
        Ok(result)
    }

    fn after_decode(&mut self) {
        if self.after_at == Some(self.calls.lock().expect("解碼鎖").len()) {
            if let Some(decoded) = self.decoded.take() {
                decoded.send(()).expect("解碼已回傳");
            }
            if let Some(continue_after) = self.continue_after.take() {
                continue_after.recv().expect("解碼後可恢復");
            }
        }
    }
}

struct DropSignal(Arc<(Mutex<usize>, Condvar)>);

impl Drop for DropSignal {
    fn drop(&mut self) {
        let (count, changed) = &*self.0;
        *count.lock().expect("取消紀錄鎖") += 1;
        changed.notify_all();
    }
}

struct FakePostprocessor {
    receivers: Mutex<VecDeque<oneshot::Receiver<Result<String>>>>,
    calls: AtomicUsize,
    started: mpsc::Sender<()>,
    dropped: Arc<(Mutex<usize>, Condvar)>,
    inputs: Mutex<Vec<(String, bool)>>,
}

use std::sync::atomic::AtomicUsize;

impl WindowPostprocessor for FakePostprocessor {
    fn process(
        &self,
        _config: AppConfig,
        translate: bool,
        original: String,
    ) -> BoxFuture<'static, Result<String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inputs
            .lock()
            .expect("後處理輸入鎖")
            .push((original, translate));
        let receiver = self.receivers.lock().expect("回應鎖").pop_front();
        let started = self.started.clone();
        let dropped = self.dropped.clone();
        Box::pin(async move {
            let _guard = DropSignal(dropped);
            started.send(()).expect("後處理已開始");
            receiver.ok_or_else(|| anyhow!("沒有假回應"))?.await?
        })
    }
}

fn postprocessor() -> (
    Arc<FakePostprocessor>,
    mpsc::Receiver<()>,
    oneshot::Sender<Result<String>>,
) {
    let (started_tx, started_rx) = mpsc::channel();
    let (result_tx, result_rx) = oneshot::channel();
    (
        Arc::new(FakePostprocessor {
            receivers: Mutex::new(VecDeque::from([result_rx])),
            calls: AtomicUsize::new(0),
            started: started_tx,
            dropped: Arc::new((Mutex::new(0), Condvar::new())),
            inputs: Mutex::new(Vec::new()),
        }),
        started_rx,
        result_tx,
    )
}

fn wait_cancelled(postprocessor: &FakePostprocessor) {
    let (count, changed) = &*postprocessor.dropped;
    let dropped = count.lock().expect("取消紀錄鎖");
    let (dropped, _) = changed
        .wait_timeout_while(dropped, Duration::from_secs(2), |count| *count == 0)
        .expect("等待後處理取消");
    assert!(*dropped > 0);
}

fn config(incremental: bool, translate: bool, proofread: bool, language: &str) -> AppConfig {
    AppConfig {
        live_caption_window_seconds: 1,
        live_caption_step_seconds: 1,
        live_caption_decode_interval_ms: 900,
        live_caption_silence_threshold: 0.01,
        live_caption_incremental_enabled: incremental,
        live_caption_translate: translate,
        live_caption_proofread: proofread,
        live_caption_language: language.into(),
        live_caption_display_mode: "both".into(),
        ..AppConfig::default()
    }
}

fn captured_queue() -> SharedQueue {
    let queue = Arc::new(Mutex::new(AudioQueue::default()));
    queue
        .lock()
        .expect("假收音鎖")
        .extend(vec![0.3; SAMPLE_RATE as usize]);
    queue
}

fn stop(queue: &SharedQueue, running: &Arc<AtomicBool>, stop_tx: &mpsc::Sender<()>) {
    queue.lock().expect("停止鎖").freeze();
    running.store(false, Ordering::SeqCst);
    stop_tx.send(()).expect("通知停止");
}

fn spawn_session(
    backend: &'static str,
    session_id: &'static str,
    config: AppConfig,
    queue: SharedQueue,
    running: Arc<AtomicBool>,
    stop_rx: mpsc::Receiver<()>,
    mut decoder: ScriptDecoder,
    sink: Arc<RecordingSink>,
    postprocessor: Arc<FakePostprocessor>,
) -> thread::JoinHandle<Result<()>> {
    thread::spawn(move || {
        process_caption_windows_with(
            &config,
            backend,
            session_id,
            &queue,
            &Arc::new(Mutex::new(None)),
            &running,
            stop_rx,
            &mut decoder,
            sink,
            postprocessor,
        )
    })
}

#[test]
fn production_window_core_keeps_backend_session_revision_and_original_snapshot() -> Result<()> {
    let sink = Arc::new(RecordingSink::default());
    for (backend, session_id, language, proofread, output) in [
        ("local_whisper", "session-local", "en", false, "譯文"),
        ("voxnote_asr", "session-remote", "zh", true, "校正文字"),
    ] {
        let queue = captured_queue();
        let running = Arc::new(AtomicBool::new(true));
        let (stop_tx, stop_rx) = mpsc::channel();
        let (decoder, calls) = ScriptDecoder::new(&["原始文字"]);
        let (postprocessor, started, response) = postprocessor();
        let count = sink.snapshot().len();
        let worker = spawn_session(
            backend,
            session_id,
            config(false, true, proofread, language),
            queue.clone(),
            running.clone(),
            stop_rx,
            decoder,
            sink.clone(),
            postprocessor.clone(),
        );
        let captions = sink.wait_for(count + 1);
        let final_caption = &captions[count];
        assert_eq!(
            (
                final_caption.session_id.as_str(),
                final_caption.sequence,
                final_caption.revision,
                final_caption.phase.as_str()
            ),
            (session_id, 1, 1, "final")
        );
        assert_eq!(final_caption.original, "原始文字");
        started.recv_timeout(Duration::from_secs(2))?;
        assert_eq!(
            postprocessor.inputs.lock().expect("輸入鎖").as_slice(),
            &[("原始文字".into(), !proofread)]
        );
        response
            .send(Ok(output.into()))
            .map_err(|_| anyhow!("假後處理應可回應"))?;
        let captions = sink.wait_for(count + 2);
        let updated = &captions[count + 1];
        assert_eq!(
            (
                updated.session_id.as_str(),
                updated.sequence,
                updated.revision,
                updated.phase.as_str()
            ),
            (session_id, 1, 2, "postprocessed")
        );
        assert_eq!(updated.original, "原始文字");
        assert_eq!(
            updated.translation.as_deref(),
            (!proofread).then_some("譯文")
        );
        assert_eq!(
            updated.display_text,
            if proofread {
                "校正文字"
            } else {
                "原始文字\n譯文"
            }
        );
        assert_eq!(
            calls.lock().expect("解碼鎖")[0],
            DecodeCall {
                backend: backend.into(),
                incremental: false,
                samples: SAMPLE_RATE as usize,
                language: language.into(),
            }
        );
        stop(&queue, &running, &stop_tx);
        worker.join().expect("視窗 worker 應結束")?;
    }
    let captions = sink.snapshot();
    assert_eq!(captions[0].sequence, captions[2].sequence);
    assert_ne!(captions[0].session_id, captions[2].session_id);
    let payload = serde_json::to_value(&captions[2])?;
    assert_eq!(payload["session_id"], "session-remote");
    assert_eq!(payload["revision"], 1);
    assert_eq!(payload["phase"], "final");
    let status = serde_json::to_value(LiveCaptionStatus {
        active: true,
        backend: Some("voxnote_asr".into()),
        audio_source: Some("system".into()),
        session_id: Some("session-remote".into()),
    })?;
    assert_eq!(status["session_id"], payload["session_id"]);
    Ok(())
}

#[test]
fn stopping_during_or_after_decode_blocks_caption_and_new_llm_for_both_backends() -> Result<()> {
    for backend in ["local_whisper", "voxnote_asr"] {
        for after_decode in [false, true] {
            let queue = captured_queue();
            let running = Arc::new(AtomicBool::new(true));
            let (stop_tx, stop_rx) = mpsc::channel();
            let (mut decoder, _) = ScriptDecoder::new(&["解碼已完成"]);
            let (entered, resume) = if after_decode {
                decoder.block_after(1)
            } else {
                decoder.block_at(1)
            };
            let sink = Arc::new(RecordingSink::default());
            let (postprocessor, _started, _response) = postprocessor();
            let worker = spawn_session(
                backend,
                "stopped",
                config(false, true, false, "en"),
                queue.clone(),
                running.clone(),
                stop_rx,
                decoder,
                sink.clone(),
                postprocessor.clone(),
            );
            entered.recv_timeout(Duration::from_secs(2))?;
            stop(&queue, &running, &stop_tx);
            resume.send(())?;
            worker.join().expect("解碼結束後 worker 應結束")?;
            assert!(sink.snapshot().is_empty());
            assert_eq!(postprocessor.calls.load(Ordering::SeqCst), 0);
        }
    }
    Ok(())
}

#[test]
fn nonincremental_window_core_deduplicates_overlapping_remote_results() -> Result<()> {
    let queue = captured_queue();
    let running = Arc::new(AtomicBool::new(true));
    let (stop_tx, stop_rx) = mpsc::channel();
    let (mut decoder, calls) = ScriptDecoder::new(&[
        "今天我們要討論系統架構的設計",
        "我們要討論系統架構的設計方向",
    ]);
    let (entered, resume) = decoder.block_at(3);
    let sink = Arc::new(RecordingSink::default());
    let (postprocessor, _, _) = postprocessor();
    let worker = spawn_session(
        "voxnote_asr",
        "dedup",
        config(false, false, false, "zh"),
        queue.clone(),
        running.clone(),
        stop_rx,
        decoder,
        sink.clone(),
        postprocessor.clone(),
    );
    sink.wait_for(1);
    queue
        .lock()
        .expect("假收音鎖")
        .extend(vec![0.3; SAMPLE_RATE as usize]);
    let deadline = Instant::now() + Duration::from_secs(2);
    while calls.lock().expect("解碼紀錄鎖").len() < 2 && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(calls.lock().expect("解碼紀錄鎖").len() >= 2);
    queue
        .lock()
        .expect("假收音鎖")
        .extend(vec![0.3; SAMPLE_RATE as usize]);
    entered.recv_timeout(Duration::from_secs(2))?;
    assert_eq!(
        sink.snapshot().len(),
        1,
        "重疊的第二個解碼結果不得新增字幕段"
    );
    assert_eq!(postprocessor.calls.load(Ordering::SeqCst), 0);
    stop(&queue, &running, &stop_tx);
    resume.send(())?;
    worker.join().expect("去重 worker 應結束")?;
    Ok(())
}

#[test]
fn incremental_confirmed_is_partial_and_stopped_flush_is_internal_only() -> Result<()> {
    let queue = captured_queue();
    let running = Arc::new(AtomicBool::new(true));
    let (stop_tx, stop_rx) = mpsc::channel();
    let (mut decoder, calls) = ScriptDecoder::new(&["今天討論系統", "今天討論資料庫"]);
    let (entered, resume) = decoder.block_at(3);
    let sink = Arc::new(RecordingSink::default());
    let (postprocessor, _started, _response) = postprocessor();
    let worker = spawn_session(
        "local_whisper",
        "incremental",
        config(true, true, false, "en"),
        queue.clone(),
        running.clone(),
        stop_rx,
        decoder,
        sink.clone(),
        postprocessor.clone(),
    );
    let captions = sink.wait_for(2);
    assert_eq!(
        (
            captions[0].sequence,
            captions[0].revision,
            captions[0].phase.as_str()
        ),
        (1, 1, "partial")
    );
    assert_eq!(
        (
            captions[1].sequence,
            captions[1].revision,
            captions[1].phase.as_str()
        ),
        (1, 2, "partial")
    );
    assert_eq!(captions[1].confirmed_text, "今天討論");
    assert!(captions[1].is_tentative);
    assert_eq!(postprocessor.calls.load(Ordering::SeqCst), 0);
    entered.recv_timeout(Duration::from_secs(3))?;
    stop(&queue, &running, &stop_tx);
    resume.send(())?;
    worker.join().expect("停止後增量 flush 應結束")?;
    assert_eq!(sink.snapshot().len(), 2);
    assert_eq!(postprocessor.calls.load(Ordering::SeqCst), 0);
    assert!(calls
        .lock()
        .expect("解碼鎖")
        .iter()
        .all(|call| call.incremental));
    Ok(())
}

#[test]
fn incremental_four_second_completion_advances_revision_and_only_then_starts_postprocess(
) -> Result<()> {
    let queue = captured_queue();
    let running = Arc::new(AtomicBool::new(true));
    let (stop_tx, stop_rx) = mpsc::channel();
    let (decoder, _) = ScriptDecoder::new(&["今天討論系統", "今天討論資料庫"]);
    let sink = Arc::new(RecordingSink::default());
    let (postprocessor, started, response) = postprocessor();
    let worker = spawn_session(
        "voxnote_asr",
        "four-second-turn",
        config(true, true, true, "zh"),
        queue.clone(),
        running.clone(),
        stop_rx,
        decoder,
        sink.clone(),
        postprocessor.clone(),
    );
    let partials = sink.wait_for(2);
    assert!(partials.iter().all(|event| event.phase == "partial"));
    assert_eq!(postprocessor.calls.load(Ordering::SeqCst), 0);
    let captions = sink.wait_for(3);
    assert_eq!(
        (
            captions[2].sequence,
            captions[2].revision,
            captions[2].phase.as_str()
        ),
        (1, 3, "final")
    );
    assert_eq!(captions[2].original, "今天討論資料庫");
    started.recv_timeout(Duration::from_secs(2))?;
    assert_eq!(
        postprocessor.inputs.lock().expect("輸入鎖").as_slice(),
        &[("今天討論資料庫".into(), false)]
    );
    response
        .send(Ok("今天討論資料庫。".into()))
        .map_err(|_| anyhow!("假校稿應可回覆"))?;
    let updated = sink.wait_for(4);
    assert_eq!(
        (
            updated[3].sequence,
            updated[3].revision,
            updated[3].phase.as_str()
        ),
        (1, 4, "postprocessed")
    );
    assert_eq!(updated[3].original, "今天討論資料庫");
    stop(&queue, &running, &stop_tx);
    worker.join().expect("四秒分段 worker 應結束")?;
    Ok(())
}

#[test]
fn pending_llm_wakeup_after_stop_cannot_update_previous_or_next_session() -> Result<()> {
    let sink = Arc::new(RecordingSink::default());
    let queue = captured_queue();
    let running = Arc::new(AtomicBool::new(true));
    let (stop_tx, stop_rx) = mpsc::channel();
    let (decoder, _) = ScriptDecoder::new(&["舊段原文"]);
    let (postprocessor, started, response) = postprocessor();
    let worker = spawn_session(
        "local_whisper",
        "old-session",
        config(false, true, false, "en"),
        queue.clone(),
        running.clone(),
        stop_rx,
        decoder,
        sink.clone(),
        postprocessor.clone(),
    );
    sink.wait_for(1);
    started.recv_timeout(Duration::from_secs(2))?;
    stop(&queue, &running, &stop_tx);
    worker.join().expect("舊 worker 應結束")?;
    let _ = response.send(Err(anyhow!("停止後不得顯示失敗")));
    wait_cancelled(&postprocessor);
    assert!(sink.errors.lock().expect("錯誤鎖").is_empty());
    let next_queue = captured_queue();
    let next_running = Arc::new(AtomicBool::new(true));
    let (next_stop, next_stop_rx) = mpsc::channel();
    let (next_decoder, _) = ScriptDecoder::new(&["新段原文"]);
    let (next_postprocessor, _, _) = self::postprocessor();
    let next_worker = spawn_session(
        "voxnote_asr",
        "new-session",
        config(false, false, false, "en"),
        next_queue.clone(),
        next_running.clone(),
        next_stop_rx,
        next_decoder,
        sink.clone(),
        next_postprocessor,
    );
    let captions = sink.wait_for(2);
    assert_eq!(
        captions
            .iter()
            .map(|event| (
                event.session_id.as_str(),
                event.sequence,
                event.phase.as_str()
            ))
            .collect::<Vec<_>>(),
        [("old-session", 1, "final"), ("new-session", 1, "final")]
    );
    stop(&next_queue, &next_running, &next_stop);
    next_worker.join().expect("新 worker 應結束")?;
    assert_eq!(sink.snapshot().len(), 2);
    Ok(())
}
