use std::time::Duration;

use tauri::{AppHandle, State};

use crate::{
    audio_recording::{DesktopRecordingManager, RecordingDeviceList},
    config::load_config,
    live_caption::{self, LiveCaptionManager, LiveCaptionStatus, StartLiveCaptionRequest},
};

const LOCAL_ASR_HEALTH_TIMEOUT_SECS: u64 = 10;
/// `/live` 子路徑的探測逾時。取較短的值：此為啟動前的額外往返，
/// 探測不到即回退至批次位址，不值得讓使用者久候。
const LIVE_ENDPOINT_PROBE_TIMEOUT_SECS: u64 = 3;

#[tauri::command]
pub async fn start_live_caption(
    request: Option<StartLiveCaptionRequest>,
    app_handle: AppHandle,
    manager: State<'_, LiveCaptionManager>,
    recording_manager: State<'_, DesktopRecordingManager>,
) -> Result<LiveCaptionStatus, String> {
    let mut config = load_config(&app_handle).map_err(|error| error.to_string())?;
    if matches!(config.live_caption_backend.as_str(), "voxnote_asr") {
        let resolved = resolve_live_caption_endpoint(&config).await?;
        check_local_asr_health(&resolved).await?;
        // 將解析結果寫回 config，使 session 期間各視窗直接沿用，
        // 不必每次轉錄重新判斷（探測僅於啟動時進行一次）。
        config.live_caption_remote_base_url = resolved;
    }
    manager
        .start(&app_handle, recording_manager.inner(), config, request)
        .map_err(|error| error.to_string())?;
    Ok(manager.status())
}

/// 決定本次 session 要使用的即時字幕轉錄位址。
///
/// 使用者已明確填寫時直接採用——自動偵測是「未設定時的合理預設」，
/// 不得覆蓋使用者的明確意圖。
///
/// 未填寫時回退至批次位址，並探測該位址是否提供 `/live` 子路徑（gateway 雙實例
/// 部署會提供，指向英文模型的實例）。探測僅於此處進行一次，session 期間不再重複，
/// 以免每個數秒的音訊視窗都多一趟往返。
///
/// 探測失敗一律視為「無 /live」而回退至原位址：舊版單一容器部署對 `/live/health`
/// 回 404（已實測），故此判斷可靠；網路異常時亦不應因探測失敗而阻斷啟動——
/// 後續的健康檢查會對實際採用的位址再把關一次。
async fn resolve_live_caption_endpoint(config: &crate::config::AppConfig) -> Result<String, String> {
    let dedicated = config.live_caption_remote_base_url.trim();
    if !dedicated.is_empty() {
        return Ok(dedicated.to_string());
    }

    let base = config.local_asr_base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("即時字幕使用自架 ASR 時，必須設定服務位址".into());
    }

    let live_url = format!("{}/live", base);
    if probe_health(&live_url).await {
        println!("[live-caption] 偵測到 {} 可用，本次 session 採用該位址", live_url);
        Ok(live_url)
    } else {
        println!("[live-caption] {} 不可用，回退沿用批次位址 {}", live_url, base);
        Ok(base.to_string())
    }
}

/// 探測某位址的 `/health` 是否回應成功；任何錯誤皆視為不可用。
async fn probe_health(base_url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(LIVE_ENDPOINT_PROBE_TIMEOUT_SECS))
        .build()
    else {
        return false;
    };
    client
        .get(format!("{}/health", base_url))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
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
