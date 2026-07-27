## 1. 後端匯出命令

- [x] 1.1 在 `src-tauri/src/commands/` 新增匯出命令模組，定義 `ExportTextFile { file_name, content }` 與 `MeetingExportResult { output_path, written, skipped, already_exists }` struct（`#[serde(rename_all = "camelCase")]`）
- [x] 1.2 實作 `export_meeting_bundle` command：接收 `meeting_id`、`parent_dir`、`folder_name`、`text_files`、`overwrite`
- [x] 1.3 實作目標子資料夾存在檢查：`overwrite = false` 且已存在時回傳 `already_exists = true` 並不寫入任何檔案
- [x] 1.4 建立子資料夾，並處理父資料夾不存在或無寫入權限的錯誤（回傳可理解的中文錯誤訊息，不留下半成品資料夾）
- [x] 1.5 依 `sort_order` 升冪查詢該會議 `recordings`，以 `01_原始檔名.ext` 序號前綴（兩位零填補）複製音訊檔；`original_file_name` 為空時退回 `file_path` 的檔名
- [x] 1.6 錄音來源檔不存在或複製失敗時記入 `skipped` 並繼續下一筆；文字檔寫入失敗則回傳錯誤
- [x] 1.7 寫入 `text_files` 中所有文字檔（UTF-8），累計 `written` 數量
- [x] 1.8 在 `src-tauri/src/lib.rs` 的 `invoke_handler` 註冊 `export_meeting_bundle`
- [x] 1.9 在 `src-tauri/src/commands/mod.rs` 匯出新模組
- [x] 1.10 確認錯誤處理未使用 `unwrap()`（依專案慣例改用 `?` 或 `anyhow`）

## 2. 前端型別與 API 層

- [x] 2.1 在 `src/types/index.ts` 新增 `MeetingExportResult` 與 `ExportTextFile` interface，欄位與 Rust struct 對應
- [x] 2.2 新增 `src/api/meetingExport.ts`，封裝 `exportMeetingBundle(meetingId, parentDir, folderName, textFiles, overwrite)` 的 `invoke` 呼叫

## 3. 匯出內容產生器

- [x] 3.1 在 `src/pages/meeting.ts` 新增 `buildExportFolderName(meetingTitle, meetingDate, createdAt)`：日期部分**先以 `new Date(meetingDate)` 測試可解析性**，不可解析或為空才改傳 `createdAt` 給 `formatExportDate()`（`formatExportDate()` 本身不會退回 `createdAt`，其無法解析時的行為是回傳 `'未指定日期'`）
- [x] 3.2 `buildExportFolderName` 以 `YYYYMMDD_會議名稱` 組合，會議名稱重用 `sanitizeFileNamePart()`；清洗後為空時使用「未命名會議」；截斷至長度上限（暫定 80 字元）以避免 Windows 長路徑問題
- [x] 3.3 新增 `buildMeetingInfoContent(meeting, recordings, transcriptVersion, exportedAt)`，產生 `meeting-info.md`：會議標題、會議日期、分類、與會者、標籤、錄音段數、所匯出的逐字稿版本（無逐字稿時標示「無」）、匯出時間

## 4. 會議詳情頁匯出流程

- [x] 4.1 擴充 `buildTranscriptSection` 的 return 型別（第 763、780、1453 行）與頁面層的 `currentTranscriptSection` 型別註記（第 1861 行），新增 `getExportContent(): { fileName, content, version } | null` 方法：以閉包讀取 `currentVersion` / `localMappings` / `loadedTranscript`，內容由 `getTranscriptDisplayText(...)` 交給 `buildTranscriptMarkdownContent(...)` 組成、檔名沿用 `buildTranscriptExportFileName(meetingTitle, meetingDate, 'md')`；無逐字稿時回傳 `null`（含第 780 行的 early-return 分支）
- [x] 4.2 在**頁面層**（`renderMeetingPage`）新增「匯出整包」按鈕，以取得 `meeting`（分類/與會者/標籤）與 `summary`；會議無任何錄音、逐字稿與摘要時改為提示「尚無可匯出的內容」且不執行匯出
- [x] 4.3 以 `@tauri-apps/plugin-dialog` 的 `open({ directory: true })` 讓使用者選定父資料夾；使用者取消時靜默結束、不顯示錯誤
- [x] 4.4 逐字稿內容取自 `currentTranscriptSection?.getExportContent()`；回傳 `null`（會議有錄音但無逐字稿）時略過逐字稿檔，匯出仍繼續且視為成功
- [x] 4.5 摘要存在時加入 `summary.content`，檔名沿用 `buildSummaryExportFileName(meetingTitle, meetingDate)`；不存在時略過且不視為失敗
- [x] 4.6 加入 `meeting-info.md` 至待寫入文字檔清單
- [x] 4.7 呼叫 `exportMeetingBundle(..., overwrite = false)`；回傳 `alreadyExists = true` 時以既有 `openModal()` 詢問使用者是否覆寫，確認則以 `overwrite = true` 重送，取消則結束流程且不修改既有檔案
- [x] 4.8 匯出成功時以 `showToast` 顯示成功訊息，包含匯出檔案數量與子資料夾名稱；`skipped` 非空時改以 `warning` 等級並說明被跳過的項目
- [x] 4.9 匯出過程中停用按鈕並顯示進行中狀態，避免重複觸發；失敗時以 `error` toast 顯示錯誤訊息

## 5. 驗證

- [x] 5.1 執行 `npm run build` 確認 TypeScript 編譯通過
- [ ] 5.2 執行 `npm run tauri dev`，實測：多段錄音會議匯出後子資料夾含全部音訊、序號順序正確
- [ ] 5.3 實測逐字稿版本一致性：切換至原始版/校稿版/手動版分別匯出，確認輸出版本與畫面一致且 `meeting-info.md` 標示正確
- [ ] 5.4 實測摘要不存在時匯出仍成功、且子資料夾不含摘要檔
- [ ] 5.5 實測 `meeting_date` 為空的會議，子資料夾日期退回 `created_at`
- [ ] 5.6 實測含非法檔名字元的會議標題可正常建立資料夾：`Q3/Q4 檢討：進度?` 應產生 `Q3_Q4 檢討：進度_`（全形 `：` 保留）
- [ ] 5.7 實測有錄音但完全無逐字稿的會議：匯出成功、子資料夾不含逐字稿檔、`meeting-info.md` 標示逐字稿為「無」
- [ ] 5.8 實測重複匯出同一會議時出現覆寫確認；分別驗證確認覆寫與取消兩種結果
- [ ] 5.9 實測錄音檔遺失情境（手動移走 `file_path` 指向的檔案）：匯出仍完成，warning toast 列出被跳過項目
- [ ] 5.10 確認既有逐字稿單檔匯出與摘要單檔匯出行為未受影響
