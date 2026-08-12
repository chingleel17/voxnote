## Why

即時字幕（`live-caption-overlay`）的設計前提是「邊聽邊轉錄」：以 5 秒視窗滑動切分，每段獨立送模型。這個前提換來低延遲，但也決定了它的品質上限——模型看不到前後文，無法回頭修正，重疊處只能靠去重補救，且完全無法在字幕出現前先確認整段語意是否合理。

使用者的實際需求其實不是「即時」，而是「看影片時有正確的字幕」。對於**已存在的影片**（而非直播），完全不需要即時：可以先把整支影片的音訊處理完，再開始播放。此時模型能取得完整音訊、能有足夠時間、能做整段校稿，品質與即時字幕不在同一個量級。

DeepSRT 的公開紀錄（`https://deepsrt.com/zh/notes/wrong-time-captions/`）印證了此路徑的可行性與其主要風險。該工具走「貼上連結 → 後端整支處理 → 產出字幕」的離線流程，其踩到的坑是**時間軸漂移**：因為它向 Gemini 索取時間戳，而該模型的時間精度不足，導致字幕與畫面對不上，最終只能改採「只信起點、時長自行以字數推算」的補救策略。

本專案不需重蹈該路徑。既有的 `voxnote_asr` 走 WhisperX，其分段本身即帶起訖時間，不需要向 LLM 索取時間戳再修補。

**服務端已提供所需的時間資訊**：`server/app.py:324-333` 的 `normalize_segment()` 於「穩定 API 格式」中同時輸出 `start` 與 `end`。缺口純粹在客戶端——`asr/mod.rs` 的 `LocalServerSegment` 只宣告了 `start`／`text`／`speaker`，serde 預設忽略未宣告欄位，故 `end` 一路被丟棄。

換言之，取得正確字幕時間軸**不需要修改服務端**，只需於客戶端補上一個欄位。這使本變更的成本遠低於「兩側同時升級」的情境。

## What Changes

- **新增以影片連結為輸入的字幕產生流程**：使用者貼上影片連結，系統擷取音訊、轉錄、產生帶時間軸的字幕，全程於播放前完成。
- **擷取音訊而非下載影片**：僅取音軌用於轉錄，不保留影片檔。
- **客戶端解析段落結束時間**：`LocalServerSegment` 補上 `end`，取用服務端既有輸出但目前被丟棄的結束時間，使字幕時間軸不需推算。服務端不需修改。
- **浮動字幕視窗呈現**：沿用即時字幕的浮動視窗呈現方式，但字幕來源改為預先產生的時間軸，依使用者自行播放的進度手動對齊起點後依時間軸推進。
- **與即時字幕互斥**：兩者共用同一個字幕視窗實體，同一時間僅允許其一顯示。
- **落盤但不歸類為會議記錄**：處理結果（影片來源、逐字稿、字幕時間軸）可儲存供後續檢視，並可產生摘要，但為獨立的實體類型，不混入既有的會議記錄清單。
- **僅支援已存在的影片，不支援直播**：預先處理的前提是音訊已完整存在。

**不在本變更範圍**：

- **內嵌播放器與字幕自動同步**：使用者要求兩種呈現模式都要，但先做浮動視窗。內嵌播放涉及影片平台的嵌入限制與播放器整合，與字幕產生的正確性無關，故拆為後續變更 `add-video-subtitle-embedded-player`。此拆分使本變更可在浮動視窗模式驗收後即進入規格基準，不需等待播放器完成。
- **即時字幕（`live-caption-overlay`）的行為**皆不變動。兩者為互補的不同能力——即時字幕處理「當下正在發生的聲音」，本能力處理「已存在的影片」。

## Capabilities

### New Capabilities
- `video-url-subtitle`: 以影片連結為輸入，於播放前完成音訊擷取與轉錄，產生帶時間軸的字幕並可落盤與摘要。

### Modified Capabilities
- `live-caption-overlay`: 啟動條件新增一項——影片字幕顯示進行中時拒絕啟動即時字幕。此為兩者共用同一字幕視窗實體的必然結果；於此側一併記載，避免日後單看即時字幕規格時遺漏此拒絕情境。其餘行為不變。

<!-- 原先預期需擴充 `local-asr-server` 的分段輸出，經查證服務端已提供 `end`
     （`server/app.py:328`），缺口純為客戶端未解析，不涉及服務端行為變更，故無此項。 -->

**不需修改 `local-asr-server`**：見上方 Why 段落。

## Design decisions

### 為何是新 capability 而非 `live-caption-overlay` 的延伸

基準 `live-caption-overlay` 明文要求「Live captions are ephemeral and not persisted」——MUST NOT 寫入資料庫、MUST NOT 產生檔案。本能力必須落盤。若以 delta 形式加入該 capability，會與其既有需求直接矛盾。故獨立為新 capability，並於此明確聲明：**本能力不是即時字幕的一種模式**。

### 為何不歸類為會議記錄

使用者明確指出產出「不叫會議紀錄」。既有會議記錄的語意是「一場實際發生的會議」，帶有與會人員、語者分離、會議摘要等前提；影片字幕沒有與會人員概念。畫面結構可以相似（上方為影片來源而非錄音檔、下方為逐字稿與摘要），但實體應分開，避免會議清單被影片項目稀釋，也避免語者分離等不適用的功能被誤套。

### 與 `add-async-transcription-queue` 的關係

本能力的處理時間與長會議錄音同級（整支影片一次轉錄），同樣面臨 HTTP 逾時與無進度回報的問題。**本變更 MUST NOT 另建第二套任務執行機制**，應沿用該變更的任務佇列與 `asr_progress` 進度回報。

**建議排序：本變更於 `add-async-transcription-queue` 之後實作。** 該變更會將批次轉錄端點改為非同步（breaking）。若本變更先行並採同步呼叫，該契約一落地就會失效，等於同一段轉錄呼叫要寫兩次。長影片正是非同步佇列的目標情境，先定契約再接上較省工。

### 時間軸來源

字幕時間軸 MUST 取自轉錄後端所回報的分段時間，MUST NOT 以字數比例推算。此為與 DeepSRT 路徑的關鍵分野——該工具因後端不提供可靠時間戳才被迫推算，本專案的後端可提供，不應主動放棄此優勢。粒度為**分段級**（segment），不要求逐字級（word）；分段級已足以支撐字幕顯示，逐字級對「看影片配字幕」的實際收益有限而服務端改動較大。

## Impact

**新增檔案**
- `src-tauri/src/video_subtitle/mod.rs`：影片來源解析、音訊擷取、字幕時間軸組裝。
- `src-tauri/src/commands/video_subtitle_cmds.rs`：對應的 Tauri commands。
- `src/pages/videoSubtitle.ts`：影片字幕頁。

**修改既有檔案**
- `src-tauri/src/asr/mod.rs`：`LocalServerSegment` 新增 `end` 欄位。既有批次與即時路徑的行為不變（兩者皆不讀取此欄位）。
- `src-tauri/src/config/mod.rs` 與 `src/types/index.ts`：新增本功能所需設定欄位。
- 資料庫 schema：新增影片字幕項目的資料表（與 `meetings` 分離）。摘要的歸屬方案見 design.md。

**不需修改**
- `server/app.py`：已於 `normalize_segment()` 輸出 `end`，無需變更。本變更與 `add-async-transcription-queue` 因此**不存在** `server/app.py` 的檔案衝突。

**外部相依**（本變更的主要成本集中於此，非程式邏輯）

- **新增 `yt-dlp` 作為 Tauri sidecar 二進位**。此非 npm／cargo 套件，而是隨應用程式打包的外部執行檔，需於 `tauri.conf.json` 的 `bundle.externalBin` 註冊（目前該區僅有 `active`／`targets`／`icon`，無 `externalBin`）。此相依為必要——影片平台的音訊串流位址需要專門的擷取邏輯，自行實作不切實際。
- **新增 `tauri-plugin-shell`**。目前 `Cargo.toml` 僅有 `opener`／`dialog`／`fs`／`notification` 四個 plugin，`tauri.conf.json` 的 `plugins` 為空；執行 sidecar 需要 shell plugin 及其對應的 `capabilities/` 權限條目。此為新增的攻擊面，權限 MUST 僅授予所註冊的 sidecar，MUST NOT 開放任意命令執行。
- **`ffmpeg` 需新增於客戶端**。既有的 ffmpeg 使用位於**服務端**（`server/app.py` 的音訊前處理），Tauri 客戶端目前完全未使用 ffmpeg。本流程若於客戶端做音訊格式轉換，即為新增的客戶端相依（同樣需 sidecar 打包）。

  **替代方案（建議優先評估）**：`yt-dlp` 可直接輸出指定格式的音訊，且服務端本就會以 ffmpeg 解碼上傳的音訊。若客戶端只負責取得音訊檔並上傳、格式轉換全交給既有服務端路徑，即可**完全避免**客戶端的 ffmpeg 相依，只需 `yt-dlp` 一個 sidecar。此決定影響相依數量與打包體積，應於任務 0.x 的前置驗證階段確定，見 design.md。

**使用範圍假設**
- 本功能供使用者個人自用。影片平台的服務條款對第三方下載工具的規範由使用者自行承擔，本變更不提供批次下載或散布功能。

**平台**
- 無新增平台限制；`yt-dlp` 與 `ffmpeg` 於三大平台皆可用。
