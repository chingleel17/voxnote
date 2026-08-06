# 單場會議整包匯出

## Why

目前使用者要取得一場會議的完整成果，必須分別操作：逐字稿從逐字稿區塊的「匯出」選單另存 TXT/MD、摘要從摘要區塊另存 MD、錄音檔則沒有匯出入口（只能自行到 AppData 目錄翻找）。一場會議若有多段錄音，逐一存檔更繁瑣，且檔名散落各處、無法辨識彼此屬於同一場會議。

使用者需要「一次匯出、一個資料夾裝完」的動作，把音訊、逐字稿、摘要（若有）整包帶走，交付給他人或歸檔至自己的檔案系統。

## What Changes

- 會議詳情頁新增「匯出整包」動作：使用者選擇一個**父資料夾**，系統在其下自動建立以 `YYYYMMDD_會議名稱` 命名的**子資料夾**，並將該會議所有產出寫入。
- 子資料夾名稱的日期取自會議日期 `meeting_date`；`meeting_date` 為空時退回 `created_at`。名稱中的非法檔名字元一律取代。
- 匯出內容：
  - **音訊**：該會議所有錄音段落（依 `sort_order` 排序、加序號前綴），而非只有第一段。
  - **逐字稿**：只匯出一份，版本依現行顯示邏輯（手動版 → 校稿版 → 原始版的既有優先序，與使用者當下檢視的版本一致），格式沿用既有 Markdown 產生器（含講者對照表）。
  - **會議摘要**：存在才匯出，格式沿用既有摘要 Markdown。
  - **`meeting-info.md`**：會議中繼資料（標題、日期、分類、與會者、標籤、錄音段數、逐字稿版本、匯出時間），讓匯出資料夾能獨立閱讀。
- 目標子資料夾若已存在，明確告知使用者並提供覆寫或取消的選擇，不靜默覆蓋既有檔案。
- 匯出結果以 toast 回報成功筆數與跳過項目（例如錄音檔在磁碟上遺失）；部分失敗不中斷整體匯出。
- 現有的逐字稿單檔匯出、摘要單檔匯出**維持不變**，本變更為新增入口而非取代。

## Capabilities

### New Capabilities
- `meeting-bundle-export`: 單場會議的整包匯出行為 — 目標資料夾選擇、子資料夾命名規則、匯出內容組成、衝突處理與結果回報。

### Modified Capabilities
<!-- 無。既有的逐字稿/摘要單檔匯出行為不變，且 openspec/specs/ 下現有規格（desktop-system-audio-capture、recording-source-selection、full-data-backup-restore、local-asr-server）皆未涵蓋單場會議匯出。 -->

## Impact

- **Rust 後端**
  - 新增 `src-tauri/src/commands/` 匯出命令（單一 Tauri command，接收會議 ID、父資料夾路徑、已組好的文字內容與覆寫旗標），負責建立子資料夾、複製錄音檔、寫入文字檔。
  - 需在 `src-tauri/src/lib.rs` 的 `invoke_handler` 註冊新命令。
  - 讀取既有 `recordings` 資料（`file_path`、`sort_order`、`original_file_name`）以複製音訊。
- **TypeScript 前端**
  - 新增 `src/api/` 匯出 wrapper（遵守「不得在頁面直接 invoke」慣例）。
  - `src/pages/meeting.ts` 新增匯出按鈕與流程：以 `@tauri-apps/plugin-dialog` 的 `open({ directory: true })` 選父資料夾，重用既有的 `buildTranscriptMarkdownContent`、摘要 Markdown 產生器、`sanitizeFileNamePart`、`formatExportDate`。
  - `src/types/index.ts` 新增匯出結果型別（與 Rust struct 對應）。
- **依賴**：無新增套件。`tauri-plugin-dialog`、`tauri-plugin-fs` 已在用。
- **資料庫**：無 schema 變更。
- **權限**：需確認 Tauri fs/dialog capability 允許寫入使用者選定的任意目錄。
