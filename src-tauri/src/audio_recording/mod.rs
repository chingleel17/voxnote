use std::{
    collections::VecDeque,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

use anyhow::{anyhow, Context, Result};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    SampleFormat, Stream,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const RECORDING_LEVEL_EVENT: &str = "recording-level";
const TARGET_SAMPLE_RATE: u32 = 48_000;
const TARGET_CHANNELS: usize = 1;
const TEMP_RECORDING_DIR: &str = "temp-recordings";
const TEMP_RECORDING_TTL_HOURS: u64 = 24;

type SharedQueue = Arc<Mutex<VecDeque<f32>>>;
type SharedError = Arc<Mutex<Option<String>>>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingSourceMode {
    Microphone,
    System,
    Mix,
}

impl RecordingSourceMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::System => "system",
            Self::Mix => "mix",
        }
    }

    pub fn needs_microphone(self) -> bool {
        matches!(self, Self::Microphone | Self::Mix)
    }

    pub fn needs_system_audio(self) -> bool {
        matches!(self, Self::System | Self::Mix)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingDeviceList {
    pub microphones: Vec<RecordingDevice>,
    pub system_outputs: Vec<RecordingDevice>,
    pub system_audio_supported: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartRecordingRequest {
    pub mode: RecordingSourceMode,
    pub microphone_device_id: Option<String>,
    pub system_device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingPreview {
    pub temp_file_path: String,
    pub duration_seconds: i64,
    pub mode: RecordingSourceMode,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingLevelPayload {
    pub level: f32,
    pub mode: RecordingSourceMode,
}

#[derive(Default)]
pub struct DesktopRecordingManager {
    inner: Mutex<Option<ActiveRecordingSession>>,
}

struct ActiveRecordingSession {
    temp_file_path: PathBuf,
    stop_tx: mpsc::Sender<()>,
    result_rx: mpsc::Receiver<Result<RecordingPreview>>,
    handle: thread::JoinHandle<()>,
}

struct SelectedInputDevice {
    device: cpal::Device,
}

pub fn cleanup_stale_temp_files(app: &AppHandle) -> Result<()> {
    let temp_dir = resolve_temp_recording_dir(app)?;
    fs::create_dir_all(&temp_dir)?;

    let now = SystemTime::now();
    for entry in fs::read_dir(&temp_dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let modified = match metadata.modified() {
            Ok(modified) => modified,
            Err(_) => continue,
        };
        let age = match now.duration_since(modified) {
            Ok(age) => age,
            Err(_) => continue,
        };

        if age >= Duration::from_secs(TEMP_RECORDING_TTL_HOURS * 60 * 60) {
            let _ = fs::remove_file(path);
        }
    }

    Ok(())
}

pub fn list_recording_devices() -> Result<RecordingDeviceList> {
    let host = cpal::default_host();
    let default_input_name = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());

    let mut microphones = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for device in devices {
            let name = device
                .description()
                .map(|info| info.name().to_string())
                .unwrap_or_else(|_| "未命名麥克風".into());
            let id = device
                .id()
                .map(|id| id.to_string())
                .unwrap_or_else(|_| name.clone());
            microphones.push(RecordingDevice {
                id,
                is_default: default_input_name.as_deref() == Some(name.as_str()),
                name,
            });
        }
    }

    #[cfg(target_os = "windows")]
    let system_outputs = list_windows_system_outputs()?;
    #[cfg(not(target_os = "windows"))]
    let system_outputs = Vec::new();

    Ok(RecordingDeviceList {
        microphones,
        system_outputs,
        system_audio_supported: cfg!(target_os = "windows"),
    })
}

pub fn start_recording(
    manager: &DesktopRecordingManager,
    app: &AppHandle,
    request: StartRecordingRequest,
) -> Result<()> {
    let mut guard = manager
        .inner
        .lock()
        .map_err(|_| anyhow!("無法取得錄音狀態"))?;
    if guard.is_some() {
        return Err(anyhow!("目前已有錄音進行中"));
    }

    let temp_dir = resolve_temp_recording_dir(app)?;
    fs::create_dir_all(&temp_dir)?;
    let temp_file_path = temp_dir.join(format!(
        "desktop-recording-{}-{}.wav",
        request.mode.as_str(),
        chrono::Utc::now().timestamp_millis()
    ));

    let app_handle = app.clone();
    let thread_request = request.clone();
    let thread_path = temp_file_path.clone();
    let (stop_tx, stop_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();

    let handle = thread::spawn(move || {
        let result = run_recording_session(app_handle, thread_request, stop_rx, thread_path);
        let _ = result_tx.send(result);
    });

    *guard = Some(ActiveRecordingSession {
        temp_file_path,
        stop_tx,
        result_rx,
        handle,
    });

    Ok(())
}

pub fn stop_recording(manager: &DesktopRecordingManager) -> Result<RecordingPreview> {
    let session = take_active_session(manager)?;
    let _ = session.stop_tx.send(());
    let _ = session.handle.join();
    session
        .result_rx
        .recv()
        .map_err(|_| anyhow!("無法取得錄音結果"))?
}

pub fn cancel_recording(manager: &DesktopRecordingManager) -> Result<()> {
    let session = take_active_session(manager)?;
    let _ = session.stop_tx.send(());
    let _ = session.handle.join();
    let _ = session.result_rx.recv();
    if session.temp_file_path.exists() {
        let _ = fs::remove_file(session.temp_file_path);
    }
    Ok(())
}

pub fn discard_temp_recording(file_path: &str) -> Result<()> {
    let path = PathBuf::from(file_path);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn take_active_session(manager: &DesktopRecordingManager) -> Result<ActiveRecordingSession> {
    let mut guard = manager
        .inner
        .lock()
        .map_err(|_| anyhow!("無法取得錄音狀態"))?;
    guard.take().ok_or_else(|| anyhow!("目前沒有進行中的錄音"))
}

fn run_recording_session(
    app: AppHandle,
    request: StartRecordingRequest,
    stop_rx: mpsc::Receiver<()>,
    temp_file_path: PathBuf,
) -> Result<RecordingPreview> {
    let running = Arc::new(AtomicBool::new(true));
    let level_value = Arc::new(Mutex::new(0.0f32));
    let error_state: SharedError = Arc::new(Mutex::new(None));
    let mic_queue: SharedQueue = Arc::new(Mutex::new(VecDeque::new()));
    let system_queue: SharedQueue = Arc::new(Mutex::new(VecDeque::new()));

    let mut mic_stream: Option<Stream> = None;
    if request.mode.needs_microphone() {
        let selected = select_input_device(request.microphone_device_id.as_deref())?;
        mic_stream = Some(start_microphone_stream(
            selected.device,
            mic_queue.clone(),
            error_state.clone(),
            level_value.clone(),
        )?);
    }

    let loopback_handle = if request.mode.needs_system_audio() {
        #[cfg(target_os = "windows")]
        {
            Some(start_windows_loopback_capture(
                request.system_device_id.as_deref(),
                system_queue.clone(),
                error_state.clone(),
                running.clone(),
                level_value.clone(),
            )?)
        }
        #[cfg(not(target_os = "windows"))]
        {
            return Err(anyhow!("目前平台尚未支援系統音訊錄音"));
        }
    } else {
        None
    };

    if let Some(stream) = &mic_stream {
        stream.play().map_err(|e| anyhow!("無法啟動麥克風錄音：{e}"))?;
    }

    let spec = hound::WavSpec {
        channels: TARGET_CHANNELS as u16,
        sample_rate: TARGET_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&temp_file_path, spec)
        .with_context(|| format!("無法建立暫存錄音檔：{}", temp_file_path.display()))?;

    let started_at = Instant::now();
    let mut last_level_emit = Instant::now();
    let mut written_samples = 0usize;
    let mut warning: Option<String> = None;

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        if let Some(err) = take_error_message(&error_state) {
            warning = Some(err);
            break;
        }

        let expected_samples = (started_at.elapsed().as_secs_f64() * f64::from(TARGET_SAMPLE_RATE))
            .floor() as usize;

        while written_samples < expected_samples {
            let mic_sample = if request.mode.needs_microphone() {
                pop_sample(&mic_queue)
            } else {
                0.0
            };
            let system_sample = if request.mode.needs_system_audio() {
                pop_sample(&system_queue)
            } else {
                0.0
            };

            let mixed = match request.mode {
                RecordingSourceMode::Microphone => mic_sample,
                RecordingSourceMode::System => system_sample,
                RecordingSourceMode::Mix => (mic_sample + system_sample).clamp(-1.0, 1.0) * 0.5,
            };

            writer.write_sample(float_to_i16(mixed))?;
            written_samples += 1;
        }

        if last_level_emit.elapsed() >= Duration::from_millis(80) {
            let level = {
                let value = level_value
                    .lock()
                    .map_err(|_| anyhow!("無法更新錄音電平"))?;
                *value
            };
            let _ = app.emit(
                RECORDING_LEVEL_EVENT,
                RecordingLevelPayload {
                    level,
                    mode: request.mode,
                },
            );
            last_level_emit = Instant::now();
        }

        thread::sleep(Duration::from_millis(12));
    }

    running.store(false, Ordering::SeqCst);
    drop(mic_stream);

    if let Some(handle) = loopback_handle {
        match handle.join() {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                let _ = warning.get_or_insert(err.to_string());
            }
            Err(_) => {
                let _ = warning.get_or_insert("系統音訊擷取執行緒異常中止".into());
            }
        };
    }

    writer.finalize()?;
    let duration_seconds =
        ((written_samples as f64) / f64::from(TARGET_SAMPLE_RATE)).ceil() as i64;

    let _ = app.emit(
        RECORDING_LEVEL_EVENT,
        RecordingLevelPayload {
            level: 0.0,
            mode: request.mode,
        },
    );

    Ok(RecordingPreview {
        temp_file_path: temp_file_path.to_string_lossy().to_string(),
        duration_seconds,
        mode: request.mode,
        warning,
    })
}

fn select_input_device(device_id: Option<&str>) -> Result<SelectedInputDevice> {
    let host = cpal::default_host();
    let requested = device_id.unwrap_or_default();
    let default_name = host
        .default_input_device()
        .and_then(|device| device.id().ok())
        .map(|id| id.to_string());

    let devices = host
        .input_devices()
        .map_err(|e| anyhow!("無法列出麥克風裝置：{e}"))?;

    for device in devices {
        let name = device
            .description()
            .map(|info| info.name().to_string())
            .unwrap_or_else(|_| "未命名麥克風".into());
        let id = device
            .id()
            .map(|id| id.to_string())
            .unwrap_or_else(|_| name.clone());
        let is_requested = !requested.is_empty() && (id == requested || name == requested);
        let is_default = requested.is_empty() && default_name.as_deref() == Some(name.as_str());
        if is_requested || is_default {
            return Ok(SelectedInputDevice {
                device,
            });
        }
    }

    Err(anyhow!("找不到指定的麥克風裝置"))
}

fn start_microphone_stream(
    device: cpal::Device,
    queue: SharedQueue,
    error_state: SharedError,
    level_value: Arc<Mutex<f32>>,
) -> Result<Stream> {
    let config = device
        .default_input_config()
        .map_err(|e| anyhow!("無法取得麥克風輸入格式：{e}"))?;
    let channels = usize::from(config.channels());
    let sample_rate = config.sample_rate();
    let stream_config: cpal::StreamConfig = config.clone().into();
    let error_state_for_stream = error_state.clone();
    let err_fn = move |err| set_error_message(&error_state_for_stream, format!("麥克風錄音失敗：{err}"));

    match config.sample_format() {
        SampleFormat::F32 => device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _| push_resampled_samples(data, channels, sample_rate, &queue, &level_value),
                err_fn,
                None,
            )
            .map_err(|e| anyhow!("無法建立麥克風錄音串流：{e}")),
        SampleFormat::I16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let converted: Vec<f32> = data
                        .iter()
                        .map(|sample| f32::from(*sample) / f32::from(i16::MAX))
                        .collect();
                    push_resampled_samples(&converted, channels, sample_rate, &queue, &level_value);
                },
                err_fn,
                None,
            )
            .map_err(|e| anyhow!("無法建立麥克風錄音串流：{e}")),
        SampleFormat::U16 => device
            .build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let converted: Vec<f32> = data
                        .iter()
                        .map(|sample| (f32::from(*sample) / f32::from(u16::MAX)) * 2.0 - 1.0)
                        .collect();
                    push_resampled_samples(&converted, channels, sample_rate, &queue, &level_value);
                },
                err_fn,
                None,
            )
            .map_err(|e| anyhow!("無法建立麥克風錄音串流：{e}")),
        other => Err(anyhow!("暫不支援的麥克風取樣格式：{other:?}")),
    }
}

fn push_resampled_samples(
    samples: &[f32],
    channels: usize,
    input_rate: u32,
    queue: &SharedQueue,
    level_value: &Arc<Mutex<f32>>,
) {
    let processed = downmix_and_resample(samples, channels, input_rate);
    let peak = processed
        .iter()
        .fold(0.0f32, |max, sample| max.max(sample.abs()));

    if let Ok(mut level) = level_value.lock() {
        *level = peak;
    }
    if let Ok(mut target) = queue.lock() {
        target.extend(processed);
    }
}

fn downmix_and_resample(samples: &[f32], channels: usize, input_rate: u32) -> Vec<f32> {
    if samples.is_empty() || channels == 0 {
        return Vec::new();
    }

    let mono: Vec<f32> = if channels == 1 {
        samples.to_vec()
    } else {
        samples
            .chunks(channels)
            .map(|frame| frame.iter().copied().sum::<f32>() / channels as f32)
            .collect()
    };

    if input_rate == TARGET_SAMPLE_RATE {
        return mono;
    }

    let ratio = f64::from(input_rate) / f64::from(TARGET_SAMPLE_RATE);
    let target_len = ((mono.len() as f64) / ratio).ceil() as usize;
    let mut resampled = Vec::with_capacity(target_len);

    for index in 0..target_len {
        let source_index = index as f64 * ratio;
        let lower = source_index.floor() as usize;
        let upper = (lower + 1).min(mono.len().saturating_sub(1));
        let fraction = (source_index - lower as f64) as f32;
        let current = mono.get(lower).copied().unwrap_or(0.0);
        let next = mono.get(upper).copied().unwrap_or(current);
        resampled.push(current + (next - current) * fraction);
    }

    resampled
}

fn pop_sample(queue: &SharedQueue) -> f32 {
    queue
        .lock()
        .ok()
        .and_then(|mut samples| samples.pop_front())
        .unwrap_or(0.0)
}

fn float_to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
}

fn set_error_message(error_state: &SharedError, message: String) {
    if let Ok(mut error) = error_state.lock() {
        if error.is_none() {
            *error = Some(message);
        }
    }
}

fn take_error_message(error_state: &SharedError) -> Option<String> {
    error_state.lock().ok().and_then(|mut error| error.take())
}

fn resolve_temp_recording_dir(app: &AppHandle) -> Result<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow!(e.to_string()))?;
    Ok(app_data_dir.join(TEMP_RECORDING_DIR))
}

#[cfg(target_os = "windows")]
fn list_windows_system_outputs() -> Result<Vec<RecordingDevice>> {
    use wasapi::{DeviceEnumerator, Direction};

    let _ = wasapi::initialize_mta();
    let enumerator = DeviceEnumerator::new()?;
    let device = enumerator.get_default_device(&Direction::Render)?;
    let name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "系統預設輸出裝置".into());

    Ok(vec![RecordingDevice {
        id: "default".into(),
        name,
        is_default: true,
    }])
}

#[cfg(target_os = "windows")]
fn start_windows_loopback_capture(
    _system_device_id: Option<&str>,
    queue: SharedQueue,
    _error_state: SharedError,
    running: Arc<AtomicBool>,
    level_value: Arc<Mutex<f32>>,
) -> Result<thread::JoinHandle<Result<()>>> {
    Ok(thread::spawn(move || -> Result<()> {
        use wasapi::{DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

        let _ = wasapi::initialize_mta();
        let enumerator = DeviceEnumerator::new()?;
        let device = enumerator.get_default_device(&Direction::Render)?;
        let desired_format =
            WaveFormat::new(32, 32, &SampleType::Float, TARGET_SAMPLE_RATE as usize, 2, None);
        let mut audio_client = device.get_iaudioclient()?;
        let (_, min_time) = audio_client.get_device_period()?;
        let stream_mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: min_time,
        };
        audio_client.initialize_client(&desired_format, &Direction::Capture, &stream_mode)?;

        let capture_client = audio_client.get_audiocaptureclient()?;
        let event_handle = audio_client.set_get_eventhandle()?;
        audio_client.start_stream()?;

        let mut sample_queue: VecDeque<u8> = VecDeque::new();
        while running.load(Ordering::SeqCst) {
            capture_client.read_from_device_to_deque(&mut sample_queue)?;
            if !sample_queue.is_empty() {
                let mut converted = Vec::new();
                while sample_queue.len() >= 8 {
                    let left = take_f32_le(&mut sample_queue)?;
                    let right = take_f32_le(&mut sample_queue)?;
                    converted.push((left + right) * 0.5);
                }
                let peak = converted
                    .iter()
                    .fold(0.0f32, |max, sample| max.max(sample.abs()));
                if let Ok(mut level) = level_value.lock() {
                    *level = peak;
                }
                if let Ok(mut target) = queue.lock() {
                    target.extend(converted);
                }
            }

            let _ = event_handle.wait_for_event(100);
        }

        audio_client.stop_stream()?;
        Ok(())
    }))
}

#[cfg(target_os = "windows")]
fn take_f32_le(queue: &mut VecDeque<u8>) -> Result<f32> {
    let bytes = [
        queue.pop_front().ok_or_else(|| anyhow!("系統音訊樣本不足"))?,
        queue.pop_front().ok_or_else(|| anyhow!("系統音訊樣本不足"))?,
        queue.pop_front().ok_or_else(|| anyhow!("系統音訊樣本不足"))?,
        queue.pop_front().ok_or_else(|| anyhow!("系統音訊樣本不足"))?,
    ];
    Ok(f32::from_le_bytes(bytes))
}
