use tauri::Manager;

mod audio_recording;
mod ai;
mod asr;
mod backup;
mod commands;
mod config;
mod db;

use commands::{
    ai_cmds::*, asr_cmds::*, backup_cmds::*, meeting_cmds::*, recording_cmds::*, settings_cmds::*,
    speaker_mapping_cmds::*, summary_cmds::*, tag_cmds::*, template_cmds::*, transcript_cmds::*,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let pool = db::init_db(&app_handle).await.expect("資料庫初始化失敗");
                app_handle.manage(pool);
                app_handle.manage(backup::DataOperationLock::default());
                app_handle.manage(audio_recording::DesktopRecordingManager::default());
                audio_recording::cleanup_stale_temp_files(&app_handle)
                    .expect("暫存錄音清理失敗");
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // meeting
            get_meetings,
            get_archived_meetings,
            get_meeting,
            create_meeting,
            update_meeting,
            delete_meeting,
            archive_meeting,
            unarchive_meeting,
            get_categories,
            create_category,
            update_category,
            delete_category,
            // transcript
            get_transcript,
            save_transcript_original,
            save_transcript_proofread,
            save_transcript_manual,
            switch_transcript_version,
            export_text_file,
            // speaker mappings
            get_speaker_mappings,
            upsert_speaker_mapping,
            delete_speaker_mapping,
            // summary
            get_summary,
            save_summary,
            // recording
            get_recording,
            get_recordings,
            save_recording,
            write_recording_file,
            list_recording_devices,
            start_desktop_recording,
            stop_desktop_recording,
            cancel_desktop_recording,
            discard_temp_recording_file,
            commit_temporary_recording,
            read_recording_file,
            delete_recording,
            set_no_break_before,
            reorder_recordings,
            remerge_segments,
            // settings
            get_settings,
            save_settings,
            test_ollama_connection,
            test_local_asr_connection,
            get_ollama_models,
            test_llm_connection_cmd,
            // ai
            proofread_transcript,
            proofread_recording_segment,
            generate_summary,
            // asr
            detect_local_asr_tools,
            start_transcription,
            // templates & saved participants
            get_saved_participants,
            upsert_saved_participant,
            delete_saved_participant,
            update_saved_participant,
            get_meeting_templates,
            create_meeting_template,
            delete_meeting_template,
            update_meeting_template,
            // tags
            get_tags,
            create_tag,
            update_tag,
            delete_tag,
            set_meeting_tags,
            // full data backup
            export_full_backup,
            preflight_full_backup,
            import_full_backup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
