use std::sync::Barrier;

use super::*;

#[test]
fn streaming_validation_does_not_require_local_model_or_window_parameters() -> Result<()> {
    let config = AppConfig {
        assembly_ai_key: "fixture-only".into(),
        live_caption_window_seconds: 0,
        live_caption_step_seconds: 0,
        live_caption_decode_interval_ms: 99_000,
        live_caption_silence_threshold: -1.0,
        live_caption_incremental_enabled: true,
        live_caption_model_path: String::new(),
        local_asr_base_url: "http://must-not-probe.invalid".into(),
        ..AppConfig::default()
    };
    validate_backend_config(&config, "assemblyai_streaming")?;
    assert!(validate_backend_config(&config, "local_whisper").is_err());
    assert!(validate_backend_config(&config, "voxnote_asr").is_err());
    Ok(())
}

#[test]
fn connecting_and_stopping_sessions_reserve_capture_until_worker_finishes() -> Result<()> {
    let manager = LiveCaptionManager::default();
    let queue = Arc::new(Mutex::new(AudioQueue::bounded(32_000)));
    queue.lock().expect("可入列").extend([1.0, 2.0]);
    let running = Arc::new(AtomicBool::new(true));
    let ready = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(SessionCompletion::default());
    let release_worker = Arc::new(Barrier::new(2));
    let (stop_tx, stop_rx) = mpsc::channel();
    let (startup_tx, startup_rx) = mpsc::sync_channel(1);
    let reported = Arc::new(Mutex::new(Vec::new()));
    let worker_finished = finished.clone();
    let worker_queue = queue.clone();
    let worker_release = release_worker.clone();
    let worker_running = running.clone();
    let worker_reported = reported.clone();
    let handle = thread::spawn(move || {
        stop_rx.recv().expect("connecting worker 應可收到取消");
        worker_release.wait();
        worker_queue.lock().expect("可取得 queue").extend([3.0]);
        finish_caption_worker(
            Err(anyhow!("AssemblyAI 串流啟動已取消")),
            &worker_running,
            &startup_tx,
            |message| {
                worker_reported
                    .lock()
                    .expect("可記錄錯誤事件")
                    .push(message)
            },
        );
        worker_finished.complete();
    });
    *manager.inner.lock().expect("可保留 session") = Some(ActiveLiveCaptionSession {
        stop_tx,
        finished: finished.clone(),
        queue: queue.clone(),
        running: running.clone(),
        ready: ready.clone(),
        handle,
        backend: "assemblyai_streaming".into(),
        audio_source: "system".into(),
        session_id: "fixture-session".into(),
        click_through_enabled: Arc::new(AtomicBool::new(false)),
    });
    assert!(manager.has_session());
    assert!(!manager.status().active, "Begin 前不能顯示執行中");
    let stop_deadline = {
        let guard = manager.inner.lock().expect("不應持有 connecting 啟動鎖");
        guard.as_ref().expect("session 應存在").request_stop()?
    };
    assert!(!running.load(Ordering::SeqCst));
    assert!(!ready.load(Ordering::SeqCst));
    assert!(
        manager.has_session(),
        "stopping 期間仍須拒絕錄音／第二個字幕 session"
    );
    assert!(stop_deadline.saturating_duration_since(Instant::now()) <= Duration::from_secs(5));
    release_worker.wait();
    assert!(finished.wait(Duration::from_secs(1)));
    assert_eq!(
        startup_rx
            .try_recv()
            .expect("啟動取消狀態應回傳")
            .expect_err("應回傳取消狀態")
            .to_string(),
        "AssemblyAI 串流啟動已取消"
    );
    assert!(
        reported.lock().expect("可讀取錯誤事件").is_empty(),
        "使用者取消 connecting 不應彈出失敗訊息"
    );
    assert!(!manager.has_session());
    assert_eq!(
        queue.lock().expect("可取得尾端快照").take_stopped_samples(),
        VecDeque::from([1.0, 2.0])
    );
    if let Some(session) = manager.inner.lock().expect("可清理 session").take() {
        session.handle.join().expect("worker 應正常結束");
    }
    Ok(())
}

#[test]
fn real_startup_failures_still_report_errors_when_worker_stops() {
    for failure in ["音源初始化失敗", "模型載入失敗", "認證失敗"] {
        let running = AtomicBool::new(false);
        let (startup_tx, startup_rx) = mpsc::sync_channel(1);
        let reported = Mutex::new(Vec::new());
        finish_caption_worker(Err(anyhow!(failure)), &running, &startup_tx, |message| {
            reported.lock().expect("錯誤事件鎖").push(message);
        });
        assert!(startup_rx.try_recv().expect("失敗狀態應回傳").is_err());
        assert_eq!(reported.lock().expect("錯誤事件鎖").as_slice(), [failure]);
    }
}

#[test]
fn completion_wait_is_bounded_and_can_be_observed_by_multiple_waiters() {
    let completion = Arc::new(SessionCompletion::default());
    assert!(!completion.wait(Duration::from_millis(5)));
    completion.complete();
    assert!(completion.wait(Duration::ZERO));
    assert!(completion.wait(Duration::ZERO));
}

#[tokio::test]
async fn stopped_session_does_not_start_llm_work() -> Result<()> {
    let running = AtomicBool::new(false);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let work = async {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok("晚到結果".into())
    };
    let queue = Arc::new(Mutex::new(AudioQueue::default()));
    assert!(run_caption_work_until_stopped(&running, &queue, work)
        .await?
        .is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    Ok(())
}

#[tokio::test]
async fn stopping_cancels_inflight_llm_work_instead_of_waiting_for_network_timeout() -> Result<()> {
    let running = AtomicBool::new(true);
    let work = std::future::pending::<Result<String>>();
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(20)).await;
        running.store(false, Ordering::SeqCst);
    };
    let started = Instant::now();
    let queue = Arc::new(Mutex::new(AudioQueue::default()));
    let (result, _) = tokio::join!(
        run_caption_work_until_stopped(&running, &queue, work),
        cancel
    );
    assert!(result?.is_none());
    assert!(started.elapsed() < Duration::from_secs(1));
    Ok(())
}

#[test]
fn capture_start_reservation_prevents_simultaneous_recording_and_caption_checks() -> Result<()> {
    let guard = audio_recording::reserve_capture_start()?;
    let contender = thread::spawn(|| audio_recording::reserve_capture_start().is_err());
    assert!(contender.join().expect("競爭的啟動執行緒應結束"));
    drop(guard);
    assert!(audio_recording::reserve_capture_start().is_ok());
    Ok(())
}

#[tokio::test]
async fn completed_llm_wakeup_after_stop_does_not_poll_inner_work_again() -> Result<()> {
    use std::sync::atomic::AtomicUsize;
    use std::task::{Poll, Waker};

    let running = Arc::new(AtomicBool::new(true));
    let calls = Arc::new(AtomicUsize::new(0));
    let pending_waker: Arc<Mutex<Option<Waker>>> = Arc::new(Mutex::new(None));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let mut started_tx = Some(started_tx);
    let work_calls = calls.clone();
    let work_waker = pending_waker.clone();
    let work = std::future::poll_fn(move |context| {
        if work_calls.fetch_add(1, Ordering::SeqCst) == 0 {
            *work_waker.lock().expect("可保存 waker") = Some(context.waker().clone());
            if let Some(started) = started_tx.take() {
                let _ = started.send(());
            }
            Poll::Pending
        } else {
            Poll::Ready(Ok("停止後不應輪詢到這個結果".into()))
        }
    });
    let cancel_running = running.clone();
    let cancel = tokio::spawn(async move {
        started_rx.await.expect("應先開始工作");
        cancel_running.store(false, Ordering::SeqCst);
        if let Some(waker) = pending_waker.lock().expect("可喚醒工作").take() {
            waker.wake();
        }
    });
    let queue = Arc::new(Mutex::new(AudioQueue::default()));
    let result = run_caption_work_until_stopped(&running, &queue, work).await?;
    cancel.await.expect("取消工作應結束");
    assert!(result.is_none());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    Ok(())
}

#[test]
fn panicked_startup_worker_reports_failure_and_releases_session_for_restart() -> Result<()> {
    let queue = Arc::new(Mutex::new(AudioQueue::bounded(32_000)));
    queue.lock().expect("可入列").extend([1.0]);
    let running = Arc::new(AtomicBool::new(true));
    let finished = Arc::new(SessionCompletion::default());
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let (startup_tx, startup_rx) = mpsc::sync_channel(1);
    let (stop_tx, _stop_rx) = mpsc::channel();
    let worker_queue = queue.clone();
    let worker_running = running.clone();
    let worker_finished = finished.clone();
    let worker_errors = errors.clone();
    let handle = thread::spawn(move || {
        run_caption_worker(
            || panic!("fixture panic before TLS Begin"),
            &worker_running,
            &worker_queue,
            &worker_finished,
            &startup_tx,
            |message| worker_errors.lock().expect("錯誤鎖").push(message),
        );
    });
    let mut slot = Some(ActiveLiveCaptionSession {
        stop_tx,
        finished: finished.clone(),
        queue: queue.clone(),
        running: running.clone(),
        ready: Arc::new(AtomicBool::new(false)),
        handle,
        backend: "assemblyai_streaming".into(),
        audio_source: "system".into(),
        session_id: "failed-start".into(),
        click_through_enabled: Arc::new(AtomicBool::new(false)),
    });
    let failure = startup_rx
        .recv_timeout(Duration::from_secs(1))?
        .expect_err("應回報失敗");
    assert!(failure.to_string().contains("非預期中止"));
    assert!(
        !failure.to_string().contains("fixture panic"),
        "不向 UI 傳遞 panic payload"
    );
    assert!(finished.wait(Duration::from_secs(1)));
    assert!(!running.load(Ordering::SeqCst));
    assert!(!queue.lock().expect("queue").is_accepting());
    assert_eq!(errors.lock().expect("錯誤鎖").len(), 1);
    assert!(reap_finished_session(&mut slot));
    assert!(slot.is_none(), "失敗 session 不可阻止下一次開始");
    assert!(
        reap_finished_session(&mut slot),
        "清理後下一次可以建立 session"
    );
    Ok(())
}

#[test]
fn terminated_worker_without_completion_notification_is_reaped() {
    let queue = Arc::new(Mutex::new(AudioQueue::default()));
    let running = Arc::new(AtomicBool::new(true));
    let finished = Arc::new(SessionCompletion::default());
    let handle = thread::spawn(|| {});
    let deadline = Instant::now() + Duration::from_secs(1);
    while !handle.is_finished() && Instant::now() < deadline {
        thread::yield_now();
    }
    assert!(handle.is_finished());
    let (stop_tx, _stop_rx) = mpsc::channel();
    let mut slot = Some(ActiveLiveCaptionSession {
        stop_tx,
        finished: finished.clone(),
        queue: queue.clone(),
        running: running.clone(),
        ready: Arc::new(AtomicBool::new(false)),
        handle,
        backend: "assemblyai_streaming".into(),
        audio_source: "system".into(),
        session_id: "missing-notification".into(),
        click_through_enabled: Arc::new(AtomicBool::new(false)),
    });
    assert!(!finished.is_finished());
    assert!(
        reap_finished_session(&mut slot),
        "已退出執行緒不可永久視為執行中"
    );
    assert!(slot.is_none());
    assert!(!running.load(Ordering::SeqCst));
    assert!(!queue.lock().expect("queue").is_accepting());
}
