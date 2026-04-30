use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, State};

use crate::{
    asr::{detect_local_asr, transcribe_assemblyai, transcribe_local_whisper, LocalAsrInfo},
    config::load_config,
    db::transcript,
};

#[tauri::command]
pub async fn detect_local_asr_tools() -> Result<Vec<LocalAsrInfo>, String> {
    Ok(detect_local_asr())
}

#[tauri::command]
pub async fn start_transcription(
    meeting_id: String,
    file_path: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<String, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;

    let app_clone = app.clone();
    let meeting_id_clone = meeting_id.clone();

    let emit_progress = move |msg: String| {
        let _ = app_clone.emit(
            "asr_progress",
            serde_json::json!({ "meetingId": meeting_id_clone, "message": msg }),
        );
    };

    let text = match config.asr_provider.as_str() {
        "assemblyai" => {
            transcribe_assemblyai(
                &config.assembly_ai_key,
                &file_path,
                &config.asr_language,
                config.speaker_detection,
                emit_progress,
            )
            .await
            .map_err(|e| e.to_string())?
        }
        "local" => {
            emit_progress("啟動本地 Whisper...".into());
            transcribe_local_whisper("whisper", &config.local_asr_model, &file_path, &config.asr_language)
                .await
                .map_err(|e| e.to_string())?
        }
        other => return Err(format!("未知的 ASR 供應商：{}", other)),
    };

    transcript::upsert_transcript_original(&pool, &meeting_id, &text)
        .await
        .map_err(|e| e.to_string())?;

    Ok(text)
}
