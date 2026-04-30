use tauri::Manager;

mod ai;
mod asr;
mod commands;
mod config;
mod db;

use commands::{
    ai_cmds::*,
    asr_cmds::*,
    meeting_cmds::*,
    recording_cmds::*,
    settings_cmds::*,
    summary_cmds::*,
    transcript_cmds::*,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let pool = db::init_db(&app_handle)
                    .await
                    .expect("資料庫初始化失敗");
                app_handle.manage(pool);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // meeting
            get_meetings,
            get_meeting,
            create_meeting,
            update_meeting,
            delete_meeting,
            get_categories,
            create_category,
            delete_category,
            // transcript
            get_transcript,
            save_transcript_original,
            save_transcript_proofread,
            switch_transcript_version,
            // summary
            get_summary,
            save_summary,
            // recording
            get_recording,
            save_recording,
            write_recording_file,
            // settings
            get_settings,
            save_settings,
            test_ollama_connection,
            get_ollama_models,
            test_llm_connection_cmd,
            // ai
            proofread_transcript,
            generate_summary,
            // asr
            detect_local_asr_tools,
            start_transcription,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
