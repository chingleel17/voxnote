use tauri::{Manager, WindowEvent};

mod ai;
mod asr;
mod audio_recording;
mod backup;
mod commands;
mod config;
mod db;
mod live_caption;
mod voiceprint;

use commands::{
    ai_cmds::*, asr_cmds::*, backup_cmds::*, live_caption_cmds::*, meeting_cmds::*,
    meeting_export_cmds::*, recording_cmds::*, settings_cmds::*, speaker_mapping_cmds::*,
    summary_cmds::*, tag_cmds::*, template_cmds::*, transcript_cmds::*, voiceprint_cmds::*,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app_handle = window.app_handle().clone();
                let live_caption_manager = app_handle.state::<live_caption::LiveCaptionManager>();
                if live_caption_manager.status().active {
                    if let Err(error) = live_caption_manager.stop(&app_handle) {
                        println!("[shutdown] 停止即時字幕失敗：{error}");
                    }
                }

                let recording_manager =
                    app_handle.state::<audio_recording::DesktopRecordingManager>();
                if audio_recording::is_recording(&recording_manager) {
                    if let Err(error) = audio_recording::stop_recording(&recording_manager) {
                        println!("[shutdown] 停止桌面錄音失敗：{error}");
                    }
                }

                app_handle.exit(0);
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let pool = db::init_db(&app_handle).await.expect("資料庫初始化失敗");
                app_handle.manage(pool);
                app_handle.manage(backup::DataOperationLock::default());
                app_handle.manage(audio_recording::DesktopRecordingManager::default());
                app_handle.manage(live_caption::LiveCaptionManager::default());
            });
            if let Some(main_window) = app.get_webview_window("main") {
                main_window.show().expect("主視窗顯示失敗");
            }

            let cleanup_app_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(error) = audio_recording::cleanup_stale_temp_files(&cleanup_app_handle) {
                    eprintln!("[startup] 暫存錄音清理失敗：{error}");
                }
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
            // meeting export
            export_meeting_bundle,
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
            import_recording_file,
            import_recording_files,
            list_recording_devices,
            start_desktop_recording,
            stop_desktop_recording,
            cancel_desktop_recording,
            discard_temp_recording_file,
            commit_temporary_recording,
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
            // live caption
            start_live_caption,
            stop_live_caption,
            get_live_caption_status,
            list_live_caption_audio_sources,
            get_live_caption_build_info,
            set_live_caption_click_through,
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
            // speaker voiceprint matching
            get_within_recording_merge_proposals,
            get_cross_recording_link_proposals,
            get_cross_meeting_identity_proposals,
            confirm_speaker_voiceprint,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
