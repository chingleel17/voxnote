## Context

會議詳情頁（`src/pages/meeting.ts`）目前有兩個各自獨立的匯出入口：逐字稿區塊的 `export-menu`（TXT / Markdown）與摘要區塊的「匯出 Markdown」按鈕，兩者都走同一個 `exportTextFile()`，以 `@tauri-apps/plugin-dialog` 的 `save()` 讓使用者逐檔另存。錄音音訊則完全沒有匯出入口——檔案存在 AppData 下的 recordings 目錄（`recording_cmds.rs` 的 `resolve_recordings_dir`），資料庫 `recordings` 表以 `file_path` 記錄絕對路徑，`sort_order` 記錄段落順序。

本變更要新增一個「一次匯出、一個資料夾裝完」的動作。關鍵限制來自 Tauri 權限模型：`src-tauri/capabilities/default.json` 只授予前端 `fs:allow-write-file` 於 `$APPDATA/**`，前端無法寫入使用者選定的任意目錄。因此**實際的檔案系統寫入必須落在 Rust 端**（Rust 不受 capability scope 約束），前端只負責選路徑與組內容。

另一個限制是逐字稿的「顯示版本」是純前端狀態：`getTranscriptDisplayText()` 需要 `transcript`、`recordings`、`currentVersion`、`speakerMappings` 四者合成，含講者標籤替換與 `shouldFollowManualBase()` 的追隨判定。後端沒有等價邏輯，重新在 Rust 實作等於複製一整套規則、且會立刻產生雙份真相。

需釐清的是：第 790–797 行確實有一段「手動版 → 校稿版 → 原始版」的鏈式判斷，但那只用於決定**初始**顯示版本 `initialVersion`（並優先尊重 DB 的 `active_version`）。之後 `currentVersion` 由 `showVersion()` 隨使用者切換更新，即為唯一真相。匯出的規則因此單純為「當下 `currentVersion` 是哪一版就匯出哪一版」，不存在另一套匯出專用的優先序。

## Goals / Non-Goals

**Goals:**

- 單一動作完成整場會議的匯出，輸出到 `父資料夾/YYYYMMDD_會議名稱/` 之下。
- 音訊涵蓋全部錄音段落並保留播放順序。
- 逐字稿只輸出一份，版本與使用者當下所見一致，不重新發明版本選擇邏輯。
- 部分項目失敗（例如錄音檔遺失）不中斷整體匯出，結果需可回報。
- 不新增任何套件依賴、不動資料庫 schema、不改動既有單檔匯出行為。

**Non-Goals:**

- 不做批次匯出多場會議（本次僅單場）。
- 不做 ZIP 打包（已與使用者確認採資料夾形式）。
- 不做匯出範本自訂、不做 PDF/DOCX 等其他格式。
- 不做匯出歷史紀錄或再匯入。
- 不改動 `full-data-backup-restore` 的整庫備份機制，兩者用途不同（備份供還原、匯出供交付）。

## Decisions

### D1：前端組內容、後端寫檔案（single Tauri command）

新增一個 Tauri command（暫名 `export_meeting_bundle`），簽章接收：會議 ID、父資料夾絕對路徑、子資料夾名稱、一組「待寫入的文字檔」（檔名 + 內容）、覆寫旗標。Rust 端負責：建立子資料夾、從 DB 讀 `recordings` 並複製音訊檔、寫入文字檔、回傳結果統計。

**為什麼：** 逐字稿的顯示版本合成邏輯（`getTranscriptDisplayText`、`shouldFollowManualBase`、講者標籤映射）只存在於前端，且與畫面狀態綁定。由前端把已合成好的 Markdown 字串交給後端，是唯一不需要複製這套規則的做法。而檔案寫入必須在 Rust，因為前端 fs 權限被限制在 `$APPDATA`。

**替代方案 A（全後端）：** command 只收會議 ID，Rust 自行查 DB 產生所有內容。被否決——需在 Rust 重寫版本優先序與講者映射，兩份實作必然漂移，且無法反映使用者當下切換的版本。

**替代方案 B（全前端）：** 放寬 capability 為 `fs:allow-write-file` 全域。被否決——為了單一功能把整個前端的檔案寫入權限開到任意路徑，安全代價不成比例。

**替代方案 C（多個細粒度 command）：** 拆成 `create_export_dir`、`copy_recording`、`write_export_file`。被否決——多次 IPC 往返、失敗時清理責任不明、無法原子性回報結果。

### D2：以既有的 section return 物件擴充為內容提供者（解決跨作用域取值）

匯出需要的狀態橫跨兩個作用域：`currentVersion`、`localMappings`、`loadedTranscript` 是 `buildTranscriptSection`（第 752 行起）的區域變數；`MeetingWithDetails`（分類、與會者、標籤，`meeting-info.md` 需要）與 `summary` 則在 `renderMeetingPage`（第 1847 行起）。沒有任何單一呼叫點目前同時看得到兩者。

決定：**擴充既有的 section return 物件**。`buildTranscriptSection` 目前已回傳 `{ el, refreshMappings }`（第 763、1453 行），且頁面層已將其存為 `currentTranscriptSection`（第 1861 行）以便呼叫 `refreshMappings`。在此物件上新增一個 `getExportContent(): { fileName, content, version } | null` 方法，內部以閉包讀取 `currentVersion` / `localMappings` / `loadedTranscript`，無逐字稿時回傳 `null`。匯出按鈕與流程放在**頁面層**，由頁面層呼叫 `currentTranscriptSection?.getExportContent()` 取得逐字稿內容，其餘資料（會議中繼資料、摘要）本就在頁面層可見。

**為什麼：** 這個 provider seam 已經存在且已在使用（`refreshMappings` 就是同一個模式），擴充它不引入新架構。匯出流程留在頁面層，才拿得到 `meeting` 與 `summary`。

**替代方案 A（把版本狀態上提至頁面層）：** 需改動 `showVersion()`、分頁按鈕、全螢幕檢視等多處既有邏輯，觸及面遠大於本次需求，且有回歸風險。否決。

**替代方案 B（按鈕放在逐字稿區塊內）：** 那裡拿不到 `meeting` 的分類/與會者/標籤與 `summary`，得再往下傳一堆參數。否決。

### D3：檔案內容全部重用既有產生器

- 逐字稿：`buildTranscriptMarkdownContent(meetingTitle, meetingDate, version, text, recordings, speakerMappings)`，其中 `text` 來自 `getTranscriptDisplayText(...)`，`version` 取當下 `currentVersion`。
- 摘要：直接用 `summary.content`（與既有「匯出 Markdown」一致，該按鈕就是原樣輸出 content）。
- 檔名：重用 `sanitizeFileNamePart()` 與 `formatExportDate()`，與既有單檔匯出的命名慣例保持一致。
- `meeting-info.md`：本次新增的產生器，組合 `MeetingWithDetails` 既有欄位。

**為什麼：** 使用者對匯出內容已有既定預期，兩條路徑產生不同格式會造成困惑；且重用讓後續格式調整只需改一處。

### D4：子資料夾命名與衝突處理

名稱格式 `YYYYMMDD_會議名稱`，日期取 `meeting_date`，為空或無法解析時退回 `created_at`。

注意 `formatExportDate()` 在輸入無法解析時回傳的是 `sanitizeFileNamePart(value) || '未指定日期'`，**它本身永遠不會退回 `created_at`**。因此退回判斷必須在呼叫端先做：先以 `new Date(meeting_date)` 測試可解析性，不可解析（或為空）才改傳 `created_at` 給 `formatExportDate()`。

名稱經 `sanitizeFileNamePart()` 清洗；標題清洗後為空則用「未命名會議」。清洗的字元類別為 `/[<>:"/\\|?*\x00-\x1F]/g`——半形 `/`、`?`、`:` 會被替換，全形字元（如 `：`）不在其中、原樣保留。

衝突處理採**前端先探測、再決定**：後端 command 在 `overwrite = false` 且目標資料夾已存在時，回傳一個可辨識的「已存在」結果而非直接失敗；前端以既有 `openModal()` 詢問使用者，選擇覆寫則以 `overwrite = true` 重送。

**為什麼：** 保持後端無 UI 耦合、不彈對話框；決策留在前端與既有 modal 元件一致。覆寫語意定為「覆蓋同名檔案」而非「刪除整個資料夾再建」——後者會誤刪使用者自行放在該資料夾的東西，風險不對等。

### D5：音訊檔命名與部分失敗容忍

錄音依 `sort_order` 升冪排序（`db::recording::get_recordings` 已如此排序，直接重用），檔名為 `01_原始檔名.ext` 形式的序號前綴（序號零填補至兩位）。

**檔名主體與副檔名必須分開取**：主體取自 `original_file_name`，副檔名一律取自磁碟上的來源檔。實作時查證了兩個寫入路徑，證實兩者會分歧——
- `commit_temporary_recording`（`recording_cmds.rs:144`）固定以 `{meeting_id}_{timestamp}.wav` 落檔，但 `original_file_name` 由前端傳 `null`（`record.ts:805`）。
- `write_recording_file` 的匯入路徑（`record.ts:803`）傳入 `state.uploadedFile.name`（可能是 `.m4a` 等），而實際落檔名是另一個參數 `fileName`。

直接沿用 `original_file_name` 的副檔名會產出無法播放的檔案，故取 `Path::file_stem()` 作主體、`source.extension()` 作副檔名；兩者皆取不到時退回 `recording`。

任一錄音的來源檔不存在或複製失敗時，記入結果的 `skipped` 清單並繼續處理下一筆，不使整個 command 失敗。文字檔寫入失敗則視為硬錯誤（代表目錄不可寫，繼續無意義）。

**為什麼：** 錄音檔可能被使用者手動移除或磁碟搬移過，這是可預期的狀態；為此讓整包匯出失敗會使功能在最需要它的舊會議上失效。

### D6：新增型別與 API wrapper

`src/types/index.ts` 新增 `MeetingExportResult`（對應 Rust `#[serde(rename_all = "camelCase")]` struct，欄位含 `outputPath`、`written`、`skipped: string[]`、`alreadyExists: boolean`）。前端呼叫透過新增的 `src/api/` wrapper，遵守專案「不得在頁面直接 invoke」的慣例。

## Risks / Trade-offs

- **[前端組內容 → 大字串經 IPC 傳輸]** → 逐字稿與摘要為純文字，量級在數十 KB 至數 MB，遠低於音訊；音訊本身仍走後端檔案複製而非 IPC，不受影響。
- **[覆寫語意為「覆蓋同名檔案」而非清空資料夾]** → 若前次匯出的錄音較多，殘留的舊序號檔案可能與新檔並存造成混淆。緩解：`meeting-info.md` 記錄本次匯出的錄音段數與匯出時間，使用者可辨識；且清空資料夾的誤刪風險更高，接受此取捨。
- **[逐字稿版本取自畫面當下狀態]** → 使用者若在匯出前切到「原始版」再匯出，得到的是原始版而非最新校稿版。此為刻意設計（與使用者確認的「他在看哪個就出哪個」一致），`meeting-info.md` 會標示所匯出的版本以消除歧義。
- **[長路徑]** → Windows 上「父資料夾 + 長會議標題 + 長原始檔名」可能逼近 MAX_PATH。緩解：對會議名稱部分做長度上限截斷（例如 80 字元），避免產生無法建立的路徑。
- **[並行寫入]** → 匯出期間使用者可能同時觸發 AI 校稿/摘要生成。匯出讀取的是呼叫當下的快照，不會產生資料損毀，僅可能匯出到稍舊的內容；不加額外鎖，避免與既有 `DataOperationLock` 語意混淆。

## Migration Plan

無資料遷移。新增純加法功能：新 Tauri command、新前端 API wrapper、新型別、會議詳情頁新增按鈕。既有 schema、既有匯出行為、既有 capability 設定皆不變更。回滾即移除新增的 command 註冊與 UI 入口。

## Open Questions

- 會議名稱在路徑中的長度上限實際取值（暫定 80 字元），待實作時以 Windows 實測確認。

（按鈕擺放位置已由 D2 決定：置於頁面層，而非逐字稿區塊內——這是取得 `meeting` 與 `summary` 的必要條件，非純版面選擇。）
