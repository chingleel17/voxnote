use anyhow::{anyhow, Result};
use futures_util::{future::BoxFuture, SinkExt, StreamExt};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        client::IntoClientRequest, http::header::AUTHORIZATION, http::HeaderValue, Message,
    },
    MaybeTlsStream, WebSocketStream,
};

const ASSEMBLYAI_STREAMING_ENDPOINT: &str = "wss://streaming.assemblyai.com/v3/ws";
const AUDIO_FRAME_SAMPLES: usize = 1_600;
const MIN_AUDIO_FRAME_SAMPLES: usize = 800;
const MAX_AUDIO_FRAME_SAMPLES: usize = 16_000;
#[cfg(test)]
const MAX_PENDING_SAMPLES: usize = 32_000;
const DROP_NOTICE_THROTTLE: std::time::Duration = std::time::Duration::from_secs(5);
const AUDIO_SEND_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);
const AUDIO_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
const FORMATTING_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
const SERVER_IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_SESSION_DURATION: Duration = Duration::from_secs(180 * 60);
const SHUTDOWN_BUDGET: Duration = Duration::from_millis(4_500);
const TERMINATION_ACK_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_POSTPROCESS_RUNNING: usize = 2;
const MAX_POSTPROCESS_PENDING: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CaptionPhase {
    Partial,
    Final,
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use crate::audio_recording::AudioQueue;
    use std::sync::{atomic::AtomicUsize, Mutex};
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

    #[derive(Default)]
    struct Observed {
        captions: Mutex<Vec<super::super::LiveCaptionPayload>>,
        notices: Mutex<Vec<String>>,
        audio: Mutex<Vec<Vec<u8>>>,
        audio_dispatch_times: Mutex<Vec<tokio::time::Instant>>,
        controls: Mutex<Vec<String>>,
        drops: AtomicUsize,
        calls: AtomicUsize,
        started_work: AtomicUsize,
        cancelled_work: AtomicUsize,
        ready: AtomicUsize,
        capture_stops: AtomicUsize,
        diagnostics: Mutex<Vec<StreamDiagnostic>>,
        read_fail: AtomicBool,
        write_fail: AtomicBool,
        llm_fail: AtomicBool,
    }

    struct Sink(Arc<Observed>);
    impl SessionEventSink for Sink {
        fn caption(&mut self, payload: super::super::LiveCaptionPayload) {
            self.0.captions.lock().expect("字幕鎖").push(payload);
        }
        fn notice(&mut self, message: &'static str) {
            self.0.notices.lock().expect("提示鎖").push(message.into());
        }
        fn ready(&mut self) {
            self.0.ready.fetch_add(1, Ordering::SeqCst);
        }
        fn diagnostic(&mut self, diagnostic: StreamDiagnostic) {
            self.0.diagnostics.lock().expect("診斷鎖").push(diagnostic);
        }
    }

    struct FakeLlm {
        observed: Arc<Observed>,
        blocked: bool,
    }
    struct BlockedWork(Arc<Observed>);
    impl Drop for BlockedWork {
        fn drop(&mut self) {
            self.0.cancelled_work.fetch_add(1, Ordering::SeqCst);
        }
    }
    impl Postprocessor for FakeLlm {
        fn process(
            &self,
            _config: crate::config::AppConfig,
            order: u64,
            original: String,
            translate: bool,
        ) -> PostprocessFuture {
            self.observed.calls.fetch_add(1, Ordering::SeqCst);
            let fail = self.observed.llm_fail.load(Ordering::SeqCst);
            let observed = self.observed.clone();
            if self.blocked {
                Box::pin(async move {
                    observed.started_work.fetch_add(1, Ordering::SeqCst);
                    let _guard = BlockedWork(observed);
                    std::future::pending().await
                })
            } else {
                Box::pin(async move {
                    observed.started_work.fetch_add(1, Ordering::SeqCst);
                    (
                        order,
                        original,
                        translate,
                        if fail {
                            Err(anyhow!("mock private detail"))
                        } else {
                            Ok("校稿或譯文".into())
                        },
                    )
                })
            }
        }
    }

    struct FakeSocket {
        incoming: UnboundedReceiver<ServerFrame>,
        responder: UnboundedSender<ServerFrame>,
        observed: Arc<Observed>,
        acknowledge: bool,
        blocked_write: bool,
        write_delay: Duration,
    }
    impl Drop for FakeSocket {
        fn drop(&mut self) {
            self.observed.drops.fetch_add(1, Ordering::SeqCst);
        }
    }
    impl StreamingSocket for FakeSocket {
        fn send_binary<'a>(&'a mut self, bytes: Vec<u8>) -> BoxFuture<'a, Result<()>> {
            Box::pin(async move {
                let dispatched_at = tokio::time::Instant::now();
                if self.blocked_write {
                    std::future::pending::<()>().await;
                }
                if !self.write_delay.is_zero() {
                    tokio::time::sleep(self.write_delay).await;
                }
                if self.observed.write_fail.load(Ordering::SeqCst) {
                    return Err(anyhow!("mock write error"));
                }
                self.observed.audio.lock().expect("封包鎖").push(bytes);
                self.observed
                    .audio_dispatch_times
                    .lock()
                    .expect("節奏鎖")
                    .push(dispatched_at);
                Ok(())
            })
        }
        fn send_text<'a>(&'a mut self, text: String) -> BoxFuture<'a, Result<()>> {
            Box::pin(async move {
                self.observed.controls.lock().expect("控制鎖").push(text);
                if self.acknowledge {
                    let _ = self
                        .responder
                        .send(ServerFrame::Text(r#"{"type":"Termination"}"#.into()));
                }
                Ok(())
            })
        }
        fn receive<'a>(&'a mut self) -> BoxFuture<'a, Result<ServerFrame>> {
            Box::pin(async move {
                let frame = self.incoming.recv().await.unwrap_or(ServerFrame::Closed);
                if self.observed.read_fail.load(Ordering::SeqCst) {
                    return Err(anyhow!("mock read error"));
                }
                Ok(frame)
            })
        }
    }

    struct FakeConnector {
        socket: Mutex<Option<FakeSocket>>,
        pending: bool,
    }
    impl StreamingConnector for FakeConnector {
        fn connect<'a>(
            &'a self,
            _url: &'a str,
            _authorization: &'a str,
        ) -> BoxFuture<'a, Result<Box<dyn StreamingSocket>>> {
            Box::pin(async move {
                if self.pending {
                    std::future::pending::<()>().await;
                }
                Ok(Box::new(
                    self.socket
                        .lock()
                        .expect("socket 鎖")
                        .take()
                        .expect("單次連線"),
                ) as Box<dyn StreamingSocket>)
            })
        }
    }

    fn fixture(
        acknowledge: bool,
        blocked_write: bool,
        pending_connect: bool,
    ) -> (FakeConnector, UnboundedSender<ServerFrame>, Arc<Observed>) {
        let (sender, incoming) = unbounded_channel();
        let observed = Arc::new(Observed::default());
        (
            FakeConnector {
                socket: Mutex::new(Some(FakeSocket {
                    incoming,
                    responder: sender.clone(),
                    observed: observed.clone(),
                    acknowledge,
                    blocked_write,
                    write_delay: Duration::ZERO,
                })),
                pending: pending_connect,
            },
            sender,
            observed,
        )
    }

    async fn drive(
        connector: &FakeConnector,
        observed: Arc<Observed>,
        queue: &crate::audio_recording::SharedQueue,
        running: &AtomicBool,
        stop_rx: mpsc::Receiver<()>,
        ready_tx: mpsc::SyncSender<Result<()>>,
        deadline: Instant,
        blocked_llm: bool,
    ) -> Result<()> {
        let mut config = crate::config::AppConfig::default();
        config.live_caption_language = "auto".into();
        config.live_caption_translate = true;
        config.live_caption_display_mode = "both".into();
        drive_config(
            connector,
            observed,
            queue,
            running,
            stop_rx,
            ready_tx,
            deadline,
            blocked_llm,
            config,
        )
        .await
    }

    async fn drive_config(
        connector: &FakeConnector,
        observed: Arc<Observed>,
        queue: &crate::audio_recording::SharedQueue,
        running: &AtomicBool,
        stop_rx: mpsc::Receiver<()>,
        ready_tx: mpsc::SyncSender<Result<()>>,
        deadline: Instant,
        blocked_llm: bool,
        config: crate::config::AppConfig,
    ) -> Result<()> {
        let mut sink = Sink(observed.clone());
        let mut stop_capture = || {
            assert!(!queue.lock().expect("停止閘門").is_accepting());
            assert!(!running.load(Ordering::SeqCst));
            observed.capture_stops.fetch_add(1, Ordering::SeqCst);
        };
        let llm = FakeLlm {
            observed: observed.clone(),
            blocked: blocked_llm,
        };
        run_session_with(
            connector,
            &llm,
            &mut sink,
            build_connection_config("offline-test-key", "test-model", "auto"),
            &config,
            queue,
            &Arc::new(Mutex::new(None)),
            running,
            stop_rx,
            ready_tx,
            deadline,
            &mut stop_capture,
        )
        .await
    }

    #[tokio::test(start_paused = true)]
    async fn full_session_uses_single_queue_final_once_and_freezes_before_capture_stop() {
        let (connector, server, observed) = fixture(true, false, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
        queue
            .lock()
            .expect("queue")
            .extend(vec![0.25; AUDIO_FRAME_SAMPLES]);
        let running = AtomicBool::new(true);
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(
                r#"{"type":"Begin","configuration":{"model":"test-model"}}"#.into(),
            ))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            server
                .send(ServerFrame::Text(
                    r#"{"type":"Turn","turn_order":0,"transcript":"Hello","end_of_turn":false}"#
                        .into(),
                ))
                .expect("partial");
            server.send(ServerFrame::Text(r#"{"type":"Turn","turn_order":0,"transcript":"Hello!","end_of_turn":true,"turn_is_formatted":true}"#.into())).expect("final");
            server.send(ServerFrame::Text(r#"{"type":"Turn","turn_order":0,"transcript":"stale","end_of_turn":true,"turn_is_formatted":true}"#.into())).expect("重送");
            for _ in 0..20 {
                tokio::task::yield_now().await;
            }
            tokio::time::advance(Duration::from_millis(100)).await;
            for _ in 0..5 {
                tokio::task::yield_now().await;
            }
            queue.lock().expect("queue").extend(vec![0.5; 400]);
            stop_tx.send(()).expect("停止");
        };
        let (result, ()) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                false
            ),
            driver
        );
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(observed.ready.load(Ordering::SeqCst), 1);
        assert_eq!(observed.calls.load(Ordering::SeqCst), 1);
        let captions = observed.captions.lock().expect("captions");
        assert_eq!(
            captions
                .iter()
                .map(|c| c.phase.as_str())
                .collect::<Vec<_>>(),
            ["partial", "final", "postprocessed"]
        );
        assert_eq!(captions[2].original, "Hello!");
        assert!(captions[2].revision > captions[1].revision);
        assert_eq!(
            observed
                .audio
                .lock()
                .expect("audio")
                .iter()
                .map(Vec::len)
                .collect::<Vec<_>>(),
            [3_200, 1_600]
        );
        assert_eq!(
            observed.controls.lock().expect("controls").as_slice(),
            [r#"{"type":"Terminate"}"#]
        );
        assert_eq!(observed.capture_stops.load(Ordering::SeqCst), 1);
        assert!(!queue.lock().expect("queue").is_accepting());
        queue.lock().expect("queue").extend([9.0]);
        assert_eq!(queue.lock().expect("queue").len(), 0);
        assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
        let diagnostics = observed.diagnostics.lock().expect("診斷鎖");
        assert!(matches!(
            diagnostics.last(),
            Some(StreamDiagnostic::Stopped {
                audio_packets: 1,
                tail_packets: 1,
                terminate_sent: true,
                termination_ack: true,
                socket_released: true,
                code: "user_stop",
                ..
            })
        ));
        let serialized = serde_json::to_string(&*diagnostics).expect("診斷應可序列化");
        assert!(!serialized.contains("Hello") && !serialized.contains("offline-test-key"));
        assert!(!serialized.contains("original") && !serialized.contains("translation"));
    }

    #[tokio::test(start_paused = true)]
    async fn no_ack_is_bounded_and_stop_cancels_pending_llm() {
        let (connector, server, observed) = fixture(false, false, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
        let running = AtomicBool::new(true);
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            for order in 0..15 {
                server.send(ServerFrame::Text(format!(r#"{{"type":"Turn","turn_order":{order},"transcript":"Hello","end_of_turn":true,"turn_is_formatted":true}}"#))).expect("Turn");
            }
            for _ in 0..100 {
                tokio::task::yield_now().await;
            }
            stop_tx.send(()).expect("停止");
            tokio::time::advance(Duration::from_millis(2_100)).await;
        };
        let (result, ()) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                true
            ),
            driver
        );
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(observed.calls.load(Ordering::SeqCst), 15);
        assert_eq!(observed.started_work.load(Ordering::SeqCst), 2);
        assert_eq!(observed.cancelled_work.load(Ordering::SeqCst), 2);
        assert!(matches!(
            observed.diagnostics.lock().expect("診斷鎖").last(),
            Some(StreamDiagnostic::Stopped {
                terminate_sent: true,
                termination_ack: false,
                socket_released: true,
                ..
            })
        ));
        assert!(observed
            .notices
            .lock()
            .expect("notices")
            .iter()
            .any(|n| n.contains("佇列已滿")));
        assert!(observed
            .captions
            .lock()
            .expect("captions")
            .iter()
            .all(|c| c.phase == "final"));
        assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn connect_and_begin_cancellation_release_capture_and_socket() {
        for pending_connect in [true, false] {
            let (connector, _server, observed) = fixture(false, false, pending_connect);
            let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
            let running = AtomicBool::new(true);
            let (stop_tx, stop_rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let driver = async {
                tokio::time::advance(Duration::from_millis(25)).await;
                stop_tx.send(()).expect("停止");
                tokio::time::advance(Duration::from_secs(2)).await;
            };
            let (result, ()) = tokio::join!(
                drive(
                    &connector,
                    observed.clone(),
                    &queue,
                    &running,
                    stop_rx,
                    ready_tx,
                    Instant::now() + Duration::from_secs(10),
                    false
                ),
                driver
            );
            assert!(result.is_err());
            assert!(ready_rx.try_recv().expect("啟動錯誤").is_err());
            assert_eq!(observed.capture_stops.load(Ordering::SeqCst), 1);
            assert_eq!(
                observed.drops.load(Ordering::SeqCst),
                if pending_connect { 0 } else { 1 }
            );
            drop(connector);
            assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn formatting_wait_expires_despite_other_frames() {
        let (connector, server, observed) = fixture(true, false, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
        let running = AtomicBool::new(true);
        let (_stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            server.send(ServerFrame::Text(r#"{"type":"Turn","turn_order":1,"transcript":"待格式化","end_of_turn":true,"turn_is_formatted":false}"#.into())).expect("未格式化");
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }
            server
                .send(ServerFrame::Text(
                    r#"{"type":"Turn","turn_order":2,"transcript":"其他段","end_of_turn":false}"#
                        .into(),
                ))
                .expect("其他段");
            tokio::time::advance(Duration::from_millis(2_050)).await;
        };
        let (result, ()) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                false
            ),
            driver
        );
        assert!(result
            .expect_err("應逾時")
            .to_string()
            .contains("格式化完成逾時"));
        assert_eq!(observed.calls.load(Ordering::SeqCst), 0);
        assert!(observed
            .captions
            .lock()
            .expect("字幕鎖")
            .iter()
            .all(|caption| caption.phase == "partial"));
        assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn any_server_frame_refreshes_idle_but_silence_expires() {
        let (connector, server, observed) = fixture(true, false, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
        let running = AtomicBool::new(true);
        let (_stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            tokio::time::advance(Duration::from_secs(14)).await;
            server.send(ServerFrame::Other).expect("binary 或 Pong");
            for _ in 0..10 {
                tokio::task::yield_now().await;
            }
            tokio::time::advance(Duration::from_secs(14)).await;
            assert!(observed.capture_stops.load(Ordering::SeqCst) == 0);
            tokio::time::advance(Duration::from_secs(2)).await;
        };
        let (result, ()) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                false
            ),
            driver
        );
        assert!(result.expect_err("應失效").to_string().contains("15 秒"));
        assert_eq!(observed.capture_stops.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn read_and_write_failures_are_reported_without_transport_details() {
        for read_failure in [true, false] {
            let (connector, server, observed) = fixture(true, false, false);
            let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
            let running = AtomicBool::new(true);
            let (_stop_tx, stop_rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            server
                .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
                .expect("Begin");
            let driver = async {
                while ready_rx.try_recv().is_err() {
                    tokio::task::yield_now().await;
                }
                if read_failure {
                    observed.read_fail.store(true, Ordering::SeqCst);
                    server.send(ServerFrame::Other).expect("喚醒 read");
                } else {
                    observed.write_fail.store(true, Ordering::SeqCst);
                    queue
                        .lock()
                        .expect("queue")
                        .extend(vec![0.1; AUDIO_FRAME_SAMPLES]);
                    tokio::time::advance(Duration::from_millis(100)).await;
                }
            };
            let (result, ()) = tokio::join!(
                drive(
                    &connector,
                    observed.clone(),
                    &queue,
                    &running,
                    stop_rx,
                    ready_tx,
                    Instant::now() + Duration::from_secs(10),
                    false
                ),
                driver
            );
            let message = result.expect_err("傳輸失敗").to_string();
            assert!(
                message.contains(if read_failure {
                    "讀取失敗"
                } else {
                    "傳送失敗"
                }),
                "{message}"
            );
            assert!(!message.contains("mock"));
            assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn session_limit_stops_while_heartbeats_keep_connection_alive() {
        let (connector, server, observed) = fixture(true, false, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
        let running = AtomicBool::new(true);
        let (_stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            for _ in 0..(180 * 60 / 10) {
                tokio::time::advance(Duration::from_secs(10)).await;
                if server.send(ServerFrame::Other).is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        };
        let (result, ()) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                false
            ),
            driver
        );
        assert!(result.is_ok(), "{result:?}");
        assert!(observed
            .notices
            .lock()
            .expect("提示鎖")
            .iter()
            .any(|notice| notice.contains("180 分鐘")));
        assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn startup_deadline_and_bad_begin_clean_up_established_resources() {
        for pending_connect in [true, false] {
            let (connector, server, observed) = fixture(true, false, pending_connect);
            let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
            let running = AtomicBool::new(true);
            let (_stop_tx, stop_rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            if !pending_connect {
                server
                    .send(ServerFrame::Text(
                        r#"{"type":"Begin","configuration":{"model":"wrong"}}"#.into(),
                    ))
                    .expect("錯誤模型");
            }
            let deadline = Instant::now()
                + if pending_connect {
                    Duration::from_millis(50)
                } else {
                    Duration::from_secs(10)
                };
            let result = drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                deadline,
                false,
            )
            .await;
            assert!(result.is_err());
            assert!(ready_rx.try_recv().expect("啟動失敗通知").is_err());
            assert_eq!(observed.capture_stops.load(Ordering::SeqCst), 1);
            if !pending_connect {
                assert_eq!(
                    observed.controls.lock().expect("控制鎖").as_slice(),
                    [r#"{"type":"Terminate"}"#]
                );
                assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn blocked_write_is_cancelled_by_stop_signal_and_terminates() {
        let (connector, server, observed) = fixture(true, true, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
        let running = AtomicBool::new(true);
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            queue
                .lock()
                .expect("queue")
                .extend(vec![0.25; AUDIO_FRAME_SAMPLES]);
            tokio::time::advance(Duration::from_millis(100)).await;
            for _ in 0..5 {
                tokio::task::yield_now().await;
            }
            stop_tx.send(()).expect("停止");
        };
        let (result, ()) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                false
            ),
            driver
        );
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(
            observed.controls.lock().expect("控制鎖").as_slice(),
            [r#"{"type":"Terminate"}"#]
        );
        assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn service_errors_are_redacted_and_never_reconnect() {
        let (connector, server, observed) = fixture(true, false, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
        let running = AtomicBool::new(true);
        let (_stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            server
                .send(ServerFrame::Text(
                    r#"{"type":"Error","error":"quota 429 offline-test-key private transcript"}"#
                        .into(),
                ))
                .expect("錯誤");
        };
        let (result, ()) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                false
            ),
            driver
        );
        let message = result.expect_err("限流應停止").to_string();
        assert!(message.contains("額度或頻率限制"));
        assert!(!message.contains("offline-test-key") && !message.contains("transcript"));
        assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
        let diagnostics = serde_json::to_string(&*observed.diagnostics.lock().expect("診斷鎖"))
            .expect("錯誤診斷應可序列化");
        assert!(diagnostics.contains("rate_limit"));
        assert!(!diagnostics.contains("offline-test-key") && !diagnostics.contains("transcript"));
    }

    #[tokio::test(start_paused = true)]
    async fn postprocessing_reuses_language_policy_and_preserves_original_on_errors() {
        for (language, proofread, fail, calls, translation) in [
            ("zh", false, false, 0, false),
            ("zh", true, false, 1, false),
            ("auto", true, false, 1, true),
            ("auto", true, true, 1, false),
        ] {
            let (connector, server, observed) = fixture(true, false, false);
            observed.llm_fail.store(fail, Ordering::SeqCst);
            let queue = Arc::new(Mutex::new(AudioQueue::bounded(MAX_PENDING_SAMPLES)));
            let running = AtomicBool::new(true);
            let (stop_tx, stop_rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            server
                .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
                .expect("Begin");
            let mut config = crate::config::AppConfig::default();
            config.live_caption_language = language.into();
            config.live_caption_translate = true;
            config.live_caption_proofread = proofread;
            config.live_caption_display_mode = "both".into();
            let driver = async {
                while ready_rx.try_recv().is_err() {
                    tokio::task::yield_now().await;
                }
                server.send(ServerFrame::Text(r#"{"type":"Turn","turn_order":1,"transcript":"原始文字","end_of_turn":true,"turn_is_formatted":true}"#.into())).expect("final");
                for _ in 0..30 {
                    tokio::task::yield_now().await;
                }
                stop_tx.send(()).expect("停止");
            };
            let (result, ()) = tokio::join!(
                drive_config(
                    &connector,
                    observed.clone(),
                    &queue,
                    &running,
                    stop_rx,
                    ready_tx,
                    Instant::now() + Duration::from_secs(10),
                    false,
                    config
                ),
                driver
            );
            assert!(result.is_ok(), "{result:?}");
            assert_eq!(observed.calls.load(Ordering::SeqCst), calls);
            let captions = observed.captions.lock().expect("字幕鎖");
            assert_eq!(captions[0].original, "原始文字");
            assert!(captions
                .iter()
                .all(|caption| caption.original == "原始文字"));
            assert_eq!(
                captions.iter().any(|caption| caption.translation.is_some()),
                translation
            );
            assert_eq!(captions.len(), if calls == 1 && !fail { 2 } else { 1 });
            if fail {
                assert!(observed
                    .notices
                    .lock()
                    .expect("提示鎖")
                    .iter()
                    .any(|notice| notice.contains("保留原文")));
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn successful_writes_keep_100ms_cadence_without_skipping_every_other_packet() {
        let (connector, server, observed) = fixture(true, false, false);
        connector
            .socket
            .lock()
            .expect("socket")
            .as_mut()
            .expect("socket 應存在")
            .write_delay = Duration::from_millis(5);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(32_000)));
        queue
            .lock()
            .expect("queue")
            .extend(vec![0.25; AUDIO_FRAME_SAMPLES * 4]);
        let running = AtomicBool::new(true);
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            tokio::time::sleep(Duration::from_millis(310)).await;
            stop_tx.send(()).expect("停止");
        };
        let (result, _) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                false
            ),
            driver
        );
        assert!(result.is_ok());
        assert_eq!(observed.audio.lock().expect("audio").len(), 4);
        let times = observed.audio_dispatch_times.lock().expect("節奏鎖");
        assert!(times
            .windows(2)
            .all(|pair| pair[1].duration_since(pair[0]) >= AUDIO_SEND_INTERVAL));
    }

    #[tokio::test(start_paused = true)]
    async fn steady_capture_with_late_wakeups_does_not_accumulate_or_drop_audio() {
        let (connector, server, observed) = fixture(true, false, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(32_000)));
        queue
            .lock()
            .expect("queue")
            .extend(vec![0.25; AUDIO_FRAME_SAMPLES]);
        let running = AtomicBool::new(true);
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            for _ in 0..20 {
                tokio::task::yield_now().await;
            }
            // 每次晚 20 ms 醒來，但擷取仍以 16 kHz 連續產生，不模擬快速補播。
            for _ in 0..140 {
                queue.lock().expect("queue").extend(vec![0.25; 1_920]);
                server.send(ServerFrame::Other).expect("Heartbeat");
                tokio::time::advance(Duration::from_millis(120)).await;
                for _ in 0..20 {
                    tokio::task::yield_now().await;
                }
            }
            assert!(
                queue.lock().expect("queue").len() <= AUDIO_FRAME_SAMPLES,
                "排程晚到不得讓持續 16 kHz 音訊逐漸累積"
            );
            stop_tx.send(()).expect("停止");
        };
        let (result, _) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                false
            ),
            driver
        );
        assert!(result.is_ok());
        assert!(!observed
            .notices
            .lock()
            .expect("notice")
            .iter()
            .any(|notice| notice.contains("音訊超過")));
        let audio = observed.audio.lock().expect("audio");
        assert_eq!(
            audio.iter().map(Vec::len).sum::<usize>(),
            (AUDIO_FRAME_SAMPLES + 140 * 1_920) * 2
        );
        assert!(audio
            .iter()
            .all(|packet| (1_600..=32_000).contains(&packet.len())));
        let diagnostics = observed.diagnostics.lock().expect("diagnostics");
        let flows: Vec<_> = diagnostics
            .iter()
            .filter_map(|diagnostic| match diagnostic {
                StreamDiagnostic::AudioFlow {
                    captured_samples,
                    sent_samples,
                    dropped_samples,
                    pending_samples,
                    ..
                } => Some((
                    *captured_samples,
                    *sent_samples,
                    *dropped_samples,
                    *pending_samples,
                )),
                _ => None,
            })
            .collect();
        assert!(!flows.is_empty(), "長時間傳送應有非文字吞吐量診斷");
        assert!(flows
            .iter()
            .all(|(captured, sent, dropped, pending)| *dropped == 0
                && *captured - *sent == *pending as u64));
        let times = observed.audio_dispatch_times.lock().expect("節奏鎖");
        assert!(times
            .windows(2)
            .all(|pair| pair[1].duration_since(pair[0]) >= AUDIO_SEND_INTERVAL));
    }

    #[tokio::test(start_paused = true)]
    async fn steady_capture_with_slow_writes_keeps_bounded_recent_audio() {
        let (connector, server, observed) = fixture(true, false, false);
        connector
            .socket
            .lock()
            .expect("socket")
            .as_mut()
            .expect("socket 應存在")
            .write_delay = Duration::from_millis(250);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(32_000)));
        let running = AtomicBool::new(true);
        let (stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let driver = async {
            while ready_rx.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
            for _ in 0..100 {
                queue
                    .lock()
                    .expect("queue")
                    .extend(vec![0.25; AUDIO_FRAME_SAMPLES]);
                server.send(ServerFrame::Other).expect("Heartbeat");
                tokio::time::sleep(AUDIO_SEND_INTERVAL).await;
            }
            let queue = queue.lock().expect("queue");
            assert_eq!(
                queue.dropped_samples(),
                0,
                "固定寫入延遲不應使傳送音訊速率一直落後"
            );
            assert!(queue.len() <= 8_000, "待傳資料應維持在短暫寫入延遲範圍內");
            drop(queue);
            stop_tx.send(()).expect("停止");
        };
        let (result, _) = tokio::join!(
            drive(
                &connector,
                observed.clone(),
                &queue,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                false
            ),
            driver
        );
        assert!(result.is_ok());
        assert!(!observed
            .notices
            .lock()
            .expect("notice")
            .iter()
            .any(|notice| notice.contains("音訊超過")));
    }

    #[tokio::test(start_paused = true)]
    async fn source_failure_while_waiting_for_begin_terminates_the_socket() {
        let (connector, server, observed) = fixture(true, false, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(32_000)));
        let running = AtomicBool::new(true);
        let error_state = Arc::new(Mutex::new(None));
        let (_stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let mut sink = Sink(observed.clone());
        let llm = FakeLlm {
            observed: observed.clone(),
            blocked: false,
        };
        let mut stop_capture = || {
            observed.capture_stops.fetch_add(1, Ordering::SeqCst);
        };
        let config = crate::config::AppConfig::default();
        let driver = async {
            tokio::time::sleep(Duration::from_millis(25)).await;
            *error_state.lock().expect("音源錯誤鎖") = Some("private device error".into());
            server.send(ServerFrame::Other).expect("frame");
        };
        let (result, _) = tokio::join!(
            run_session_with(
                &connector,
                &llm,
                &mut sink,
                build_connection_config("fixture-only", "test-model", "auto"),
                &config,
                &queue,
                &error_state,
                &running,
                stop_rx,
                ready_tx,
                Instant::now() + Duration::from_secs(10),
                &mut stop_capture
            ),
            driver
        );
        assert!(result
            .expect_err("音源失敗應停止")
            .to_string()
            .contains("音源已中斷"));
        assert!(ready_rx.try_recv().expect("啟動錯誤").is_err());
        assert_eq!(observed.capture_stops.load(Ordering::SeqCst), 1);
        assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
        assert_eq!(
            observed.controls.lock().expect("controls").as_slice(),
            [r#"{"type":"Terminate"}"#]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn blocked_transport_write_times_out_in_the_production_session_loop() {
        let (connector, server, observed) = fixture(true, true, false);
        let queue = Arc::new(Mutex::new(AudioQueue::bounded(32_000)));
        queue
            .lock()
            .expect("queue")
            .extend(vec![0.25; AUDIO_FRAME_SAMPLES]);
        let running = AtomicBool::new(true);
        let (_stop_tx, stop_rx) = mpsc::channel();
        let (ready_tx, _ready_rx) = mpsc::sync_channel(1);
        server
            .send(ServerFrame::Text(r#"{"type":"Begin"}"#.into()))
            .expect("Begin");
        let started = tokio::time::Instant::now();
        let result = drive(
            &connector,
            observed.clone(),
            &queue,
            &running,
            stop_rx,
            ready_tx,
            Instant::now() + Duration::from_secs(10),
            false,
        )
        .await;
        assert!(result
            .expect_err("卡住的 write 應逾時")
            .to_string()
            .contains("音訊寫入逾時"));
        assert!(
            started.elapsed() >= AUDIO_WRITE_TIMEOUT && started.elapsed() < Duration::from_secs(2)
        );
        assert_eq!(observed.capture_stops.load(Ordering::SeqCst), 1);
        assert_eq!(observed.drops.load(Ordering::SeqCst), 1);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct TurnCaptionUpdate {
    pub turn_order: u64,
    pub revision: u64,
    pub text: String,
    pub phase: CaptionPhase,
    pub words: Option<serde_json::Value>,
}

type PostprocessFuture = BoxFuture<'static, (u64, String, bool, Result<String>)>;

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
    error_state: crate::audio_recording::SharedError,
    running: Arc<AtomicBool>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::SyncSender<Result<()>>,
    startup_deadline: Instant,
    stop_capture: &mut dyn FnMut(),
) -> Result<()> {
    let connection = build_connection_config(
        &config.assembly_ai_key,
        &config.live_caption_assemblyai_model,
        &config.live_caption_language,
    );
    let mut sink = AppEventSink {
        app,
        session_id,
        audio_source,
        detailed_diagnostics: std::env::var("VOXNOTE_STREAMING_DIAGNOSTICS")
            .is_ok_and(|value| value == "1"),
    };
    run_session_with(
        &TlsWebSocketConnector,
        &LlmPostprocessor,
        &mut sink,
        connection,
        &config,
        &queue,
        &error_state,
        &running,
        stop_rx,
        ready_tx,
        startup_deadline,
        stop_capture,
    )
    .await
}

#[cfg(test)]
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
            Ok(Ok(ServerFrame::Ping(_) | ServerFrame::Other)) => continue,
            Ok(Ok(ServerFrame::Closed)) => return Err(anyhow!("AssemblyAI 在 Begin 前關閉連線")),
            Ok(Err(error)) => return Err(error),
            Err(_) => return Err(anyhow!("等待 AssemblyAI Begin 逾時")),
        }
    }
}

trait SessionEventSink {
    fn caption(&mut self, payload: super::LiveCaptionPayload);
    fn notice(&mut self, message: &'static str);
    fn ready(&mut self);
    fn diagnostic(&mut self, _diagnostic: StreamDiagnostic) {}
}

/// 僅記錄協定階段、數量與時間，不接受金鑰、音訊或文字內容欄位。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum StreamDiagnostic {
    Ready {
        at_ms: u64,
    },
    Turn {
        turn_order: u64,
        phase: &'static str,
        at_ms: u64,
    },
    Stopping {
        audio_packets: u64,
        at_ms: u64,
    },
    AudioFlow {
        at_ms: u64,
        captured_samples: u64,
        sent_samples: u64,
        dropped_samples: u64,
        pending_samples: usize,
        max_write_ms: u64,
    },
    Stopped {
        duration_ms: u64,
        stop_elapsed_ms: u64,
        termination_wait_ms: u64,
        audio_packets: u64,
        tail_packets: u64,
        terminate_sent: bool,
        termination_ack: bool,
        socket_released: bool,
        code: &'static str,
    },
}

fn elapsed_ms(started: tokio::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn diagnostic_code(result: &Result<()>, session_limit: bool) -> &'static str {
    let Err(error) = result else {
        return if session_limit {
            "session_limit"
        } else {
            "user_stop"
        };
    };
    let message = error.to_string();
    if message.contains("已取消") {
        "cancelled"
    } else if message.contains("認證") {
        "authentication"
    } else if message.contains("額度") || message.contains("頻率") {
        "rate_limit"
    } else if message.contains("音源") {
        "capture_error"
    } else if message.contains("15 秒") {
        "server_idle"
    } else if message.contains("寫入逾時") {
        "write_timeout"
    } else if message.contains("啟動逾時") || message.contains("Begin 逾時") {
        "startup_timeout"
    } else if message.contains("Turn") || message.contains("格式化") || message.contains("模型")
    {
        "protocol"
    } else {
        "transport_or_configuration"
    }
}

struct AppEventSink {
    app: AppHandle,
    session_id: String,
    audio_source: String,
    detailed_diagnostics: bool,
}

impl SessionEventSink for AppEventSink {
    fn caption(&mut self, mut payload: super::LiveCaptionPayload) {
        payload.session_id = self.session_id.clone();
        let _ = self.app.emit(super::LIVE_CAPTION_EVENT, payload);
    }

    fn notice(&mut self, message: &'static str) {
        super::emit_error(&self.app, message.into());
    }

    fn ready(&mut self) {
        let _ = self.app.emit(
            super::LIVE_CAPTION_STATUS_EVENT,
            super::LiveCaptionStatus {
                active: true,
                backend: Some("assemblyai_streaming".into()),
                audio_source: Some(self.audio_source.clone()),
                session_id: Some(self.session_id.clone()),
            },
        );
    }

    fn diagnostic(&mut self, diagnostic: StreamDiagnostic) {
        if matches!(diagnostic, StreamDiagnostic::Turn { .. }) && !self.detailed_diagnostics {
            return;
        }
        let wall_time_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        if let Ok(json) = serde_json::to_string(&diagnostic) {
            println!(
                "[assemblyai-streaming] session={} wall_time_ms={} {}",
                self.session_id, wall_time_ms, json
            );
        }
    }
}

trait Postprocessor {
    fn process(
        &self,
        config: crate::config::AppConfig,
        turn_order: u64,
        original: String,
        translate: bool,
    ) -> PostprocessFuture;
}

struct LlmPostprocessor;

impl Postprocessor for LlmPostprocessor {
    fn process(
        &self,
        config: crate::config::AppConfig,
        turn_order: u64,
        original: String,
        translate: bool,
    ) -> PostprocessFuture {
        Box::pin(async move {
            let prompt = if translate {
                "你是即時字幕翻譯員。請將輸入內容翻譯成自然、簡潔的繁體中文台灣用語。只輸出譯文，不要加註解、前綴或引號。"
            } else {
                super::PROOFREAD_CORE_SYSTEM
            };
            let result = super::call_llm(&config, prompt, &original).await;
            (turn_order, original, translate, result)
        })
    }
}

fn stop_requested(running: &AtomicBool, stop_rx: &mpsc::Receiver<()>) -> bool {
    !running.load(Ordering::SeqCst)
        || matches!(
            stop_rx.try_recv(),
            Ok(()) | Err(mpsc::TryRecvError::Disconnected)
        )
}

async fn wait_for_session_stop(running: &AtomicBool, stop_rx: &mpsc::Receiver<()>) {
    while !stop_requested(running, stop_rx) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn caption_payload(
    update: TurnCaptionUpdate,
    config: &crate::config::AppConfig,
) -> super::LiveCaptionPayload {
    let partial = update.phase == CaptionPhase::Partial;
    super::LiveCaptionPayload {
        session_id: String::new(),
        sequence: update.turn_order.saturating_add(1),
        revision: update.revision,
        phase: if partial { "partial" } else { "final" }.into(),
        original: update.text.clone(),
        translation: None,
        display_text: super::build_display_text(
            &update.text,
            None,
            &config.live_caption_display_mode,
        ),
        confirmed_text: if partial {
            String::new()
        } else {
            update.text.clone()
        },
        tentative_text: if partial { update.text } else { String::new() },
        is_tentative: partial,
    }
}

fn check_capture(error_state: &crate::audio_recording::SharedError) -> Result<()> {
    if error_state
        .lock()
        .map_err(|_| anyhow!("音源狀態無法讀取"))?
        .take()
        .is_some()
    {
        return Err(anyhow!("即時字幕音源已中斷"));
    }
    Ok(())
}

fn gate_postprocess(
    mut work: PostprocessFuture,
    queue: crate::audio_recording::SharedQueue,
) -> PostprocessFuture {
    Box::pin(std::future::poll_fn(move |context| {
        let guard = match queue.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !guard.is_accepting() {
            // 週期式停止檢查將釋放此 future；停止閘門關閉後不再輪詢 LLM。
            return std::task::Poll::Pending;
        }
        work.as_mut().poll(context)
    }))
}

async fn run_session_with(
    connector: &dyn StreamingConnector,
    postprocessor: &dyn Postprocessor,
    sink: &mut dyn SessionEventSink,
    connection: Result<AssemblyAiConnectionConfig>,
    config: &crate::config::AppConfig,
    queue: &crate::audio_recording::SharedQueue,
    error_state: &crate::audio_recording::SharedError,
    running: &AtomicBool,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::SyncSender<Result<()>>,
    startup_deadline: Instant,
    stop_capture: &mut dyn FnMut(),
) -> Result<()> {
    let mut socket = None;
    let mut ready = false;
    let authorization = connection
        .as_ref()
        .map(|value| value.authorization.clone())
        .unwrap_or_default();
    let started = tokio::time::Instant::now();
    let mut audio_packets = 0u64;
    let mut sent_samples = 0u64;
    let mut max_write_ms = 0u64;
    let mut last_flow_report = started;
    let mut tail_packets = 0u64;
    let mut terminate_sent = false;
    let mut termination_ack = false;
    let mut termination_wait_ms = 0u64;
    let mut session_limit = false;
    let result = async {
        let connection = connection?;
        if stop_requested(running, &stop_rx) {
            return Err(anyhow!("AssemblyAI 串流啟動已取消"));
        }
        check_capture(error_state)?;
        let deadline = tokio::time::Instant::from_std(startup_deadline);
        if deadline <= tokio::time::Instant::now() {
            return Err(anyhow!("AssemblyAI 串流啟動逾時"));
        }
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        let connect = connector.connect(&connection.url, &connection.authorization);
        tokio::pin!(connect);
        socket = Some(loop {
            tokio::select! {
                biased;
                _ = poll.tick() => {
                    if stop_requested(running, &stop_rx) { return Err(anyhow!("AssemblyAI 串流啟動已取消")); }
                    check_capture(error_state)?;
                }
                result = &mut connect => {
                    break result?;
                }
                _ = tokio::time::sleep_until(deadline) => return Err(anyhow!("AssemblyAI 串流啟動逾時")),
            }
        });
        loop {
            if stop_requested(running, &stop_rx) { return Err(anyhow!("AssemblyAI 串流啟動已取消")); }
            check_capture(error_state)?;
            let current = socket.as_mut().ok_or_else(|| anyhow!("AssemblyAI socket 未建立"))?;
            let frame = tokio::select! {
                biased;
                _ = poll.tick() => continue,
                result = current.receive() => result.map_err(|_| anyhow!("AssemblyAI WebSocket 讀取失敗"))?,
                _ = tokio::time::sleep_until(deadline) => return Err(anyhow!("等待 AssemblyAI Begin 逾時")),
            };
            match frame {
                ServerFrame::Text(text) => {
                    let event = parse_server_event(&text, &connection.authorization)?;
                    match event {
                        ServerEvent::Begin { .. } => { validate_begin_model(&event, &connection.model)?; break; }
                        ServerEvent::Error { message } => return Err(anyhow!("{message}")),
                        ServerEvent::Ignore => continue,
                        _ => return Err(anyhow!("AssemblyAI Begin 前收到非預期事件")),
                    }
                }
                ServerFrame::Closed => return Err(anyhow!("AssemblyAI 在 Begin 前關閉連線")),
                ServerFrame::Ping(_) | ServerFrame::Other => {}
            }
        }
        if stop_requested(running, &stop_rx) { return Err(anyhow!("AssemblyAI 串流啟動已取消")); }
        ready_tx.send(Ok(())).map_err(|_| anyhow!("即時字幕啟動狀態無法回傳"))?;
        ready = true;
        sink.ready();
        sink.diagnostic(StreamDiagnostic::Ready { at_ms: elapsed_ms(started) });

        let mut reducer = TurnReducer::default();
        let mut pending: VecDeque<PostprocessFuture> = VecDeque::new();
        let mut active = futures_util::stream::FuturesUnordered::new();
        let mut last_frame = tokio::time::Instant::now();
        let mut last_audio_dispatch = None;
        let mut ticker = tokio::time::interval(AUDIO_SEND_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut check = tokio::time::interval(Duration::from_millis(10));
        check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            if stop_requested(running, &stop_rx) { break; }
            check_capture(error_state)?;
            if tokio::time::Instant::now().duration_since(started) >= MAX_SESSION_DURATION {
                session_limit = true;
                sink.notice("即時字幕已達 180 分鐘上限，連線正在停止");
                break;
            }
            reducer.check_formatting_deadlines(tokio::time::Instant::now().into_std())?;
            while active.len() < MAX_POSTPROCESS_RUNNING {
                let Some(work) = pending.pop_front() else { break; };
                active.push(work);
            }
            let current = socket.as_mut().ok_or_else(|| anyhow!("AssemblyAI socket 未建立"))?;
            tokio::select! {
                frame = current.receive() => {
                    last_frame = tokio::time::Instant::now();
                    if stop_requested(running, &stop_rx) { break; }
                    match frame.map_err(|_| anyhow!("AssemblyAI WebSocket 讀取失敗"))? {
                        ServerFrame::Text(text) => match parse_server_event(&text, &connection.authorization)? {
                            event @ ServerEvent::Turn { .. } => {
                                if let Some(update) = reducer.apply(event, tokio::time::Instant::now().into_std())? {
                                    let is_final = update.phase == CaptionPhase::Final;
                                    let turn_order = update.turn_order;
                                    let original = update.text.clone();
                                    let gate = queue.lock().map_err(|_| anyhow!("音訊佇列無法讀取"))?;
                                    if !gate.is_accepting() || !running.load(Ordering::SeqCst) { break; }
                                    if update.revision == 1 {
                                        sink.diagnostic(StreamDiagnostic::Turn { turn_order, phase: "first_caption", at_ms: elapsed_ms(started) });
                                    }
                                    if is_final {
                                        sink.diagnostic(StreamDiagnostic::Turn { turn_order, phase: "final", at_ms: elapsed_ms(started) });
                                    }
                                    sink.caption(caption_payload(update, config));
                                    if is_final {
                                        let (translate, proofread) = super::resolve_translate_or_proofread(
                                            config.live_caption_translate,
                                            config.live_caption_proofread,
                                            &config.live_caption_display_mode,
                                            &config.live_caption_language,
                                        );
                                        if translate || proofread {
                                            if pending.len() == MAX_POSTPROCESS_PENDING {
                                                pending.pop_front();
                                                sink.notice("字幕後處理佇列已滿，略過較舊工作並保留原文");
                                            }
                                            pending.push_back(gate_postprocess(
                                                postprocessor.process(config.clone(), turn_order, original, translate),
                                                queue.clone(),
                                            ));
                                        }
                                    }
                                }
                            }
                            ServerEvent::Error { message } => return Err(anyhow!("{message}")),
                            ServerEvent::Termination => return Err(anyhow!("AssemblyAI 串流提前結束")),
                            _ => {}
                        },
                        ServerFrame::Closed => return Err(anyhow!("AssemblyAI 串流連線已關閉")),
                        ServerFrame::Ping(_) | ServerFrame::Other => {}
                    }
                }
                _ = check.tick() => {
                    if stop_requested(running, &stop_rx) { break; }
                    check_capture(error_state)?;
                    if tokio::time::Instant::now().duration_since(last_frame) >= SERVER_IDLE_TIMEOUT {
                        return Err(anyhow!("AssemblyAI 連線 15 秒內沒有收到服務訊息"));
                    }
                    if queue.lock().map_err(|_| anyhow!("音訊佇列無法讀取"))?
                        .take_drop_notice(Instant::now(), DROP_NOTICE_THROTTLE) {
                        sink.notice("串流音訊超過佇列上限，已捨棄較舊音訊");
                    }
                    if last_flow_report.elapsed() >= DROP_NOTICE_THROTTLE {
                        let queue = queue.lock().map_err(|_| anyhow!("音訊佇列無法讀取"))?;
                        sink.diagnostic(StreamDiagnostic::AudioFlow {
                            at_ms: elapsed_ms(started), captured_samples: queue.captured_samples(),
                            sent_samples, dropped_samples: queue.dropped_samples(),
                            pending_samples: queue.len(), max_write_ms,
                        });
                        last_flow_report = tokio::time::Instant::now();
                    }
                }
                Some((order, original, translated, result)) = active.next(), if !active.is_empty() => {
                    let gate = queue.lock().map_err(|_| anyhow!("音訊佇列無法讀取"))?;
                    if !gate.is_accepting() || !running.load(Ordering::SeqCst) { break; }
                    match result {
                        Ok(value) if !value.trim().is_empty() => {
                            let value = value.trim().to_string();
                            if let Some(turn) = reducer.turns.get_mut(&order) {
                                if turn.final_text.as_deref() == Some(original.as_str()) {
                                    turn.revision = turn.revision.saturating_add(1);
                                    sink.diagnostic(StreamDiagnostic::Turn { turn_order: order, phase: "postprocessed", at_ms: elapsed_ms(started) });
                                    sink.caption(super::LiveCaptionPayload {
                                        session_id: String::new(), sequence: order.saturating_add(1),
                                        revision: turn.revision, phase: "postprocessed".into(),
                                        original: original.clone(), translation: translated.then(|| value.clone()),
                                        display_text: if translated { super::build_display_text(&original, Some(&value), &config.live_caption_display_mode) } else { value },
                                        confirmed_text: original, tentative_text: String::new(), is_tentative: false,
                                    });
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(_) => sink.notice("字幕後處理失敗，已保留原文"),
                    }
                }
                _ = ticker.tick() => {
                    if stop_requested(running, &stop_rx) { break; }
                    let dispatched_at = tokio::time::Instant::now();
                    let packet_samples = audio_packet_samples(last_audio_dispatch, dispatched_at);
                    let frame = {
                        let mut queue = queue.lock().map_err(|_| anyhow!("音訊佇列無法讀取"))?;
                        if queue.len() >= AUDIO_FRAME_SAMPLES {
                            let count = queue.len().min(packet_samples);
                            Some(encode_pcm16_le(&queue.drain(..count).collect::<Vec<_>>()))
                        } else { None }
                    };
                    if let Some(frame) = frame {
                        let frame_samples = frame.len() / 2;
                        tokio::select! {
                            result = tokio::time::timeout(AUDIO_WRITE_TIMEOUT, current.send_binary(frame)) => {
                                result.map_err(|_| anyhow!("AssemblyAI 音訊寫入逾時"))?
                                    .map_err(|_| anyhow!("AssemblyAI 音訊傳送失敗"))?;
                            }
                            _ = wait_for_session_stop(running, &stop_rx) => break,
                        }
                        max_write_ms = max_write_ms.max(elapsed_ms(dispatched_at));
                        sent_samples = sent_samples.saturating_add(frame_samples as u64);
                        last_audio_dispatch = Some(dispatched_at);
                        audio_packets = audio_packets.saturating_add(1);
                        ticker.reset_at(dispatched_at + AUDIO_SEND_INTERVAL);
                    }
                }
            }
        }
        Ok(())
    }.await;

    // 收尾順序與 capture callback 使用同一把鎖，快照不會收進停止後才完成的 callback。
    let stopped_at = {
        let mut guard = match queue.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.freeze();
        guard.stopped_at().unwrap_or_else(Instant::now)
    };
    running.store(false, Ordering::SeqCst);
    stop_capture();
    sink.diagnostic(StreamDiagnostic::Stopping {
        audio_packets,
        at_ms: elapsed_ms(started),
    });
    if let Some(mut socket) = socket {
        let mut tail = match queue.lock() {
            Ok(mut guard) => guard.take_stopped_samples(),
            Err(poisoned) => poisoned.into_inner().take_stopped_samples(),
        };
        let deadline =
            tokio::time::Instant::now() + SHUTDOWN_BUDGET.saturating_sub(stopped_at.elapsed());
        while !tail.is_empty() {
            let count = tail.len().min(16_000);
            let mut samples: Vec<f32> = tail.drain(..count).collect();
            if samples.len() < MIN_AUDIO_FRAME_SAMPLES {
                samples.resize(MIN_AUDIO_FRAME_SAMPLES, 0.0);
            }
            let limit = (tokio::time::Instant::now() + AUDIO_WRITE_TIMEOUT).min(deadline);
            if !matches!(
                tokio::time::timeout_at(limit, socket.send_binary(encode_pcm16_le(&samples))).await,
                Ok(Ok(()))
            ) {
                break;
            }
            tail_packets = tail_packets.saturating_add(1);
        }
        let limit = (tokio::time::Instant::now() + AUDIO_WRITE_TIMEOUT).min(deadline);
        if tokio::time::timeout_at(limit, socket.send_text(r#"{"type":"Terminate"}"#.into()))
            .await
            .is_ok_and(|result| result.is_ok())
        {
            terminate_sent = true;
            let ack_started = tokio::time::Instant::now();
            let ack_deadline =
                (tokio::time::Instant::now() + TERMINATION_ACK_TIMEOUT).min(deadline);
            while tokio::time::Instant::now() < ack_deadline {
                match tokio::time::timeout_at(ack_deadline, socket.receive()).await {
                    Ok(Ok(ServerFrame::Text(text)))
                        if matches!(
                            parse_server_event(&text, &authorization),
                            Ok(ServerEvent::Termination)
                        ) =>
                    {
                        termination_ack = true;
                        break;
                    }
                    Ok(Ok(ServerFrame::Closed)) | Ok(Err(_)) | Err(_) => break,
                    _ => {}
                }
            }
            termination_wait_ms = elapsed_ms(ack_started);
        }
    }
    sink.diagnostic(StreamDiagnostic::Stopped {
        duration_ms: elapsed_ms(started),
        stop_elapsed_ms: u64::try_from(stopped_at.elapsed().as_millis()).unwrap_or(u64::MAX),
        termination_wait_ms,
        audio_packets,
        tail_packets,
        terminate_sent,
        termination_ack,
        socket_released: true,
        code: diagnostic_code(&result, session_limit),
    });
    if !ready {
        if let Err(error) = &result {
            let _ = ready_tx.try_send(Err(anyhow!("{error}")));
        }
    }
    result
}

#[cfg(test)]
async fn wait_for_stop(running: &AtomicBool) {
    while running.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
pub(super) struct BoundedAudioQueue {
    samples: VecDeque<f32>,
    last_drop_notice: Option<std::time::Instant>,
}

#[cfg(test)]
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

#[cfg(test)]
fn remaining_audio_cadence(last_sent_at: Option<Instant>, now: Instant) -> Duration {
    last_sent_at
        .map(|sent| AUDIO_SEND_INTERVAL.saturating_sub(now.saturating_duration_since(sent)))
        .unwrap_or(Duration::ZERO)
}

/// 晚到的 tick 以同一段牆鐘時間涵蓋較長音訊，維持音訊速率而不快速補送多包。
fn audio_packet_samples(
    previous: Option<tokio::time::Instant>,
    now: tokio::time::Instant,
) -> usize {
    let elapsed = previous
        .map(|previous| now.saturating_duration_since(previous))
        .unwrap_or(AUDIO_SEND_INTERVAL);
    // 只在真實已擷取樣本中取資料；向上取整到樣本單位，避免長時間的分數截斷累積。
    let samples = elapsed
        .as_nanos()
        .saturating_mul(super::SAMPLE_RATE as u128)
        .div_ceil(1_000_000_000);
    samples.clamp(AUDIO_FRAME_SAMPLES as u128, MAX_AUDIO_FRAME_SAMPLES as u128) as usize
}

#[cfg(test)]
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
    Other,
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

pub(super) fn parse_server_event(text: &str, _api_key: &str) -> Result<ServerEvent> {
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
                .and_then(|value| value.get("model").or_else(|| value.get("speech_model")))
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
            let detail = event
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let lower = detail.to_ascii_lowercase();
            let message =
                if lower.contains("rate") || lower.contains("quota") || lower.contains("429") {
                    "AssemblyAI 額度或頻率限制，請稍後重試"
                } else if lower.contains("auth")
                    || lower.contains("key")
                    || lower.contains("401")
                    || lower.contains("403")
                {
                    "AssemblyAI 認證失敗，請檢查 API Key"
                } else {
                    "AssemblyAI 服務回報錯誤"
                }
                .to_string();
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
        ServerEvent::Begin { model: None } => Ok(()),
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
            // WSS 的信任根功能不會選擇加密 provider；既有 process default 存在時沿用。
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                let _ = rustls::crypto::ring::default_provider().install_default();
            }
            let mut request = url
                .into_client_request()
                .map_err(|error| anyhow!("AssemblyAI WebSocket URL 無效：{error}"))?;
            let authorization = HeaderValue::from_str(authorization)
                .map_err(|_| anyhow!("AssemblyAI API Key 格式無效"))?;
            request.headers_mut().insert(AUTHORIZATION, authorization);
            let (socket, _) = connect_async_with_config(request, None, true)
                .await
                .map_err(|error| match error {
                    tokio_tungstenite::tungstenite::Error::Http(response)
                        if matches!(response.status().as_u16(), 401 | 403) =>
                    {
                        anyhow!("AssemblyAI 認證失敗，請檢查 API Key")
                    }
                    tokio_tungstenite::tungstenite::Error::Http(response)
                        if response.status().as_u16() == 429 =>
                    {
                        anyhow!("AssemblyAI 額度或頻率限制，請稍後重試")
                    }
                    _ => anyhow!("AssemblyAI WebSocket 連線失敗，請檢查網路與認證設定"),
                })?;
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
                .map_err(|_| anyhow!("AssemblyAI 音訊傳送失敗"))
        })
    }

    fn send_text<'a>(&'a mut self, text: String) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            self.socket
                .send(Message::text(text))
                .await
                .map_err(|_| anyhow!("AssemblyAI 控制訊息傳送失敗"))
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
                            .map_err(|_| anyhow!("AssemblyAI Pong 傳送失敗"))?;
                        return Ok(ServerFrame::Ping(payload));
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(ServerFrame::Closed),
                    Some(Ok(Message::Binary(_))) | Some(Ok(Message::Pong(_))) => {
                        return Ok(ServerFrame::Other)
                    }
                    Some(Err(_)) => return Err(anyhow!("AssemblyAI WebSocket 讀取失敗")),
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
    use futures_util::{FutureExt, SinkExt};
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

    #[tokio::test]
    async fn local_wss_tls_initialization_returns_error_without_panicking() {
        use tokio::io::AsyncWriteExt;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("本機 TLS 測試 listener 應可啟動");
        let address = listener.local_addr().expect("應取得本機位址");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("應接受 TCP 連線");
            // 故意不提供 TLS 憑證；應回傳握手錯誤，而不是在 crypto provider 初始化時 panic。
            stream.shutdown().await.expect("應關閉測試 TCP 連線");
        });
        let url = format!("wss://{address}");
        let attempt =
            std::panic::AssertUnwindSafe(TlsWebSocketConnector.connect(&url, "fixture-only"))
                .catch_unwind();
        let result = tokio::time::timeout(Duration::from_secs(2), attempt)
            .await
            .expect("TLS 測試應有限時間完成");
        server.await.expect("測試 server 應正常結束");
        assert!(
            result.is_ok(),
            "WSS crypto provider 初始化不可讓 worker panic"
        );
        assert!(
            result.expect("不可 panic").is_err(),
            "沒有 TLS 的 server 應被拒絕"
        );
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
                message: "AssemblyAI 認證失敗，請檢查 API Key".into()
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
        assert!(validate_begin_model(&ServerEvent::Begin { model: None }, "model-a").is_ok());
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
