use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, State};

use crate::{
    asr::{
        detect_local_asr, transcribe_assemblyai, transcribe_local_whisper, transcribe_voxnote_asr,
        LocalAsrInfo,
    },
    backup::DataOperationLock,
    commands::ai_cmds::proofread_recording_segment_with_config,
    config::load_config,
    db::{meeting, recording, transcript},
};

fn emit_asr_progress(app: &AppHandle, meeting_id: &str, message: &str) {
    let _ = app.emit(
        "asr_progress",
        serde_json::json!({ "meetingId": meeting_id, "message": message }),
    );
}

#[tauri::command]
pub async fn detect_local_asr_tools() -> Result<Vec<LocalAsrInfo>, String> {
    Ok(detect_local_asr())
}

/// 轉譯指定錄音段落，完成後自動合併所有段落至逐字稿
#[tauri::command]
pub async fn start_transcription(
    meeting_id: String,
    recording_id: String,
    file_path: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<String, String> {
    let _guard = data_lock.try_begin_write()?;
    let config = load_config(&app).map_err(|e| e.to_string())?;

    // 預期講者人數取自該會議的與會人員數，可提升語者分離準確度；取不到時以 0 表示未知
    let speakers_expected = meeting::get_meeting(&pool, &meeting_id)
        .await
        .ok()
        .flatten()
        .map(|m| m.participants.len() as u32)
        .unwrap_or(0);

    let text = match config.asr_provider.as_str() {
        "assemblyai" => transcribe_assemblyai(
            &config.assembly_ai_key,
            &file_path,
            &config.asr_language,
            &config.assembly_ai_speech_model,
            config.speaker_detection,
            speakers_expected,
            |msg| emit_asr_progress(&app, &meeting_id, &msg),
        )
        .await
        .map_err(|e| e.to_string())?,
        "voxnote_asr" => transcribe_voxnote_asr(
            &config.local_asr_base_url,
            &file_path,
            &config.asr_language,
            config.speaker_detection,
            speakers_expected,
            |msg| emit_asr_progress(&app, &meeting_id, &msg),
        )
        .await
        .map_err(|e| e.to_string())?,
        "local" => {
            emit_asr_progress(&app, &meeting_id, "啟動本地 Whisper...");
            transcribe_local_whisper(
                "whisper",
                &config.local_asr_model,
                &file_path,
                &config.asr_language,
            )
            .await
            .map_err(|e| e.to_string())?
        }
        other => return Err(format!("未知的 ASR 供應商：{}", other)),
    };

    // 儲存此段落的轉譯結果
    recording::update_segment_transcript(&pool, &recording_id, &text)
        .await
        .map_err(|e| e.to_string())?;

    // 取得所有已轉譯段落並合併
    let segments = recording::get_segment_transcripts_with_break(&pool, &meeting_id)
        .await
        .map_err(|e| e.to_string())?;
    let merged = recording::merge_segment_texts(&segments);

    transcript::sync_generated_content_from_recordings(&pool, &meeting_id, true)
        .await
        .map_err(|e| e.to_string())?;

    if config.auto_proofread_after_transcription {
        emit_asr_progress(&app, &meeting_id, "逐字稿已產生，正在進行 AI 校稿...");
        match proofread_recording_segment_with_config(&config, &pool, &meeting_id, &recording_id)
            .await
        {
            Ok(result) => {
                let message = match result.warning {
                    Some(warning) => format!("AI 校稿已完成，但結果可能不完整：{}", warning),
                    None => "AI 校稿已完成".to_string(),
                };
                emit_asr_progress(&app, &meeting_id, &message);
            }
            Err(err) => {
                let message = format!("AI 校稿失敗，已保留原始逐字稿：{}", err);
                emit_asr_progress(&app, &meeting_id, &message);
            }
        }
    }

    Ok(merged)
}
