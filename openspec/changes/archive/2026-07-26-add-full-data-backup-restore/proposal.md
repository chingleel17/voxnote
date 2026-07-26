## Why

VoxNote 的會議、逐字稿、摘要、模板與錄音分散於 SQLite 資料庫及檔案系統，使用者更換電腦時只能手動複製資料夾，且資料庫中的絕對錄音路徑可能因 Windows 使用者名稱不同而失效。提供完整備份與還原功能，讓使用者能以單一檔案安全遷移資料，並避免逐筆修正路徑。

## What Changes

- 在設定頁提供建立完整資料備份的操作，輸出可攜式 ZIP 檔。
- 備份會包含所有會議資料、分類、標籤、範本、常用參與者、逐字稿、摘要、說話者對應、錄音與封存檔案。
- 備份資料以相對路徑描述錄音與封存檔，避免還原後依賴舊電腦的 Windows 使用者資料夾路徑。
- 提供匯入備份操作，支援以備份內容覆蓋現有資料，或合併尚未存在的資料。
- 匯入與覆蓋操作須顯示資料影響範圍並要求使用者明確確認。
- 備份不得包含 API 金鑰、端點憑證或裝置專屬設定。
- 匯入期間會暫停其他會修改 VoxNote 資料的操作，完成後重新載入目前畫面中的資料。

## Capabilities

### New Capabilities
- `full-data-backup-restore`: 定義完整資料 ZIP 備份、可攜錄音路徑、覆蓋還原與合併匯入的使用者行為及資料完整性要求。

### Modified Capabilities
- 無

## Impact

- 前端設定頁、API 封裝與共用型別：`src/pages/settings.ts`、`src/api/`、`src/types/index.ts`
- Tauri command、應用註冊與新的備份服務：`src-tauri/src/commands/`、`src-tauri/src/lib.rs`、`src-tauri/src/`
- SQLite 資料讀寫與錄音、封存檔案路徑處理：`src-tauri/src/db/`、`src-tauri/src/commands/recording_cmds.rs`、`src-tauri/src/commands/meeting_cmds.rs`
- 可能新增 Rust ZIP 壓縮與暫存檔案處理相依套件
