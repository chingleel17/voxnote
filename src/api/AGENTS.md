# TAURI API LAYER

## OVERVIEW
前端唯一合法的後端呼叫點。每個檔案對應一個資源域，封裝 `invoke()` 呼叫。

## FILES

| 檔案 | 對應後端 commands |
|------|------------------|
| `meetings.ts` | `meeting_cmds.rs`（含 category） |
| `recordings.ts` | `recording_cmds.rs` |
| `transcripts.ts` | `transcript_cmds.rs` |
| `summaries.ts` | `summary_cmds.rs` |
| `settings.ts` | `settings_cmds.rs` |
| `tags.ts` | `tag_cmds.rs` |
| `templates.ts` | `template_cmds.rs` |
| `participants.ts` | `meeting_cmds.rs`（saved participants） |

## CONVENTIONS

- 函式命名與 Rust command 名稱一致（camelCase vs snake_case 轉換）
- 所有函式為 `async`，回傳值型別來自 `../types/index.ts`
- 錯誤直接 throw（呼叫端處理 try/catch）

## ANTI-PATTERNS

- 禁止在此層包含 DOM 操作或業務邏輯
- 新增 command 時前後端必須同步（後端 `lib.rs` invoke_handler 須一併更新）
