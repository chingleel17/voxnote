# TAURI COMMANDS LAYER

## OVERVIEW
Tauri IPC handlers。所有 `#[tauri::command]` 函式在此，前端透過 `invoke()` 呼叫。每個資源一個檔案，`mod.rs` 統一重新匯出。

## FILES

| 檔案 | 暴露的 commands |
|------|----------------|
| `meeting_cmds.rs` | get_meetings, get_meeting, create_meeting, update_meeting, delete_meeting, get_categories, create_category, delete_category, get_saved_participants, upsert_saved_participant, delete_saved_participant |
| `recording_cmds.rs` | get_recording, get_recordings, save_recording, import_recording_file, delete_recording |
| `transcript_cmds.rs` | get_transcript, save_transcript_original, save_transcript_proofread, switch_transcript_version |
| `summary_cmds.rs` | get_summary, save_summary |
| `settings_cmds.rs` | get_settings, save_settings, test_ollama_connection, get_ollama_models, test_llm_connection_cmd |
| `ai_cmds.rs` | proofread_transcript, generate_summary |
| `asr_cmds.rs` | detect_local_asr_tools, start_transcription |
| `tag_cmds.rs` | get_tags, create_tag, delete_tag, set_meeting_tags |
| `template_cmds.rs` | get_meeting_templates, create_meeting_template, delete_meeting_template |

## CONVENTIONS

- 函式簽名：`#[tauri::command] pub async fn xxx(pool: State<'_, SqlitePool>, ...) -> Result<T, String>`
- 錯誤以 `map_err(|e| e.to_string())` 轉為 String 回傳前端
- 業務邏輯委派至 `db/`、`ai/`、`asr/` 模組，command 本身只做參數傳遞
- 新增 command 後須在 `lib.rs` 的 `invoke_handler![]` 中注册

## ANTI-PATTERNS

- 禁止在 command 函式內直接寫 SQL（透過 db/ 模組）
- 禁止遺漏在 `lib.rs` 注册（前端會收到 invoke 找不到 command 錯誤）
