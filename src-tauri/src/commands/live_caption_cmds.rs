use std::time::Duration;

use tauri::{AppHandle, State};

use crate::{
    audio_recording::{DesktopRecordingManager, RecordingDeviceList},
    config::load_config,
    live_caption::{self, LiveCaptionManager, LiveCaptionStatus, StartLiveCaptionRequest},
};

const LOCAL_ASR_HEALTH_TIMEOUT_SECS: u64 = 10;

#[tauri::command]
pub async fn start_live_caption(
    request: Option<StartLiveCaptionRequest>,
    app_handle: AppHandle,
    manager: State<'_, LiveCaptionManager>,
    recording_manager: State<'_, DesktopRecordingManager>,
) -> Result<LiveCaptionStatus, String> {
    let config = load_config(&app_handle).map_err(|error| error.to_string())?;
    if matches!(config.live_caption_backend.as_str(), "voxnote_asr") {
        check_local_asr_health(live_caption::live_caption_remote_base_url(&config)).await?;
    }
    manager
        .start(&app_handle, recording_manager.inner(), config, request)
        .map_err(|error| error.to_string())?;
    Ok(manager.status())
}

#[tauri::command]
pub async fn stop_live_caption(
    app_handle: AppHandle,
    manager: State<'_, LiveCaptionManager>,
) -> Result<LiveCaptionStatus, String> {
    manager
        .stop(&app_handle)
        .map_err(|error| error.to_string())?;
    Ok(manager.status())
}

#[tauri::command]
pub async fn get_live_caption_status(
    manager: State<'_, LiveCaptionManager>,
) -> Result<LiveCaptionStatus, String> {
    Ok(manager.status())
}

#[tauri::command]
pub async fn list_live_caption_audio_sources() -> Result<RecordingDeviceList, String> {
    live_caption::list_audio_sources().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_live_caption_build_info() -> Result<live_caption::LiveCaptionBuildInfo, String> {
    Ok(live_caption::build_info())
}

/// 由主控制面板切換「鎖定」（＝穿透模式）。鎖定開啟時視窗預設穿透，
/// 游標移到標題列或邊框感應區仍可動態恢復互動（供拖曳、調整大小、關閉字幕視窗）；
/// 鎖定關閉時視窗恆為可互動。
#[tauri::command]
pub async fn set_live_caption_click_through(
    ignore: bool,
    app_handle: AppHandle,
    manager: State<'_, LiveCaptionManager>,
) -> Result<(), String> {
    manager
        .set_lock(&app_handle, ignore)
        .map_err(|error| error.to_string())
}

async fn check_local_asr_health(base_url: &str) -> Result<(), String> {
    let base_url = base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err("即時字幕使用自架 ASR 時，必須設定服務位址".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(LOCAL_ASR_HEALTH_TIMEOUT_SECS))
        .build()
        .map_err(|error| format!("無法建立自架 ASR 連線：{}", error))?;
    let response = client
        .get(format!("{}/health", base_url))
        .send()
        .await
        .map_err(|error| format!("無法連線至自架 ASR 服務：{}", error))?;
    if !response.status().is_success() {
        return Err(format!(
            "自架 ASR 服務健康檢查失敗（HTTP {}）",
            response.status()
        ));
    }
    Ok(())
}
