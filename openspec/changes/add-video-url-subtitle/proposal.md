## Why

使用者需要的不是邊播放邊猜測內容的即時字幕，而是觀看已存在的 YouTube 影片時，能使用預先完成且具可靠時間軸的字幕。既有即時字幕採短視窗逐段辨識，模型缺少完整上下文；影片既已完整存在，應先擷取整支音訊並完成轉錄，再開始播放。

原規劃將呈現拆成兩種模式：先以浮動字幕視窗搭配外部播放器手動對齊，再於另一個 change 新增內嵌播放器。這會形成兩套播放狀態與同步機制，且外部瀏覽器的暫停、跳轉、播放速度與緩衝皆無法由 VoxNote 可靠掌握。第一種模式成本不低，體驗卻較差，沒有保留的必要。

本變更改為單一路徑：處理完成後開啟 VoxNote 的獨立播放視窗，以 YouTube IFrame Player API 播放影片，字幕直接依播放器的實際時間同步。原 `add-video-subtitle-embedded-player` 的必要內容併入本變更，該 change 移除。

轉錄服務已提供所需時間資訊：`server/app.py` 的 `normalize_segment()` 同時輸出 `start` 與 `end`。客戶端目前只因 `LocalServerSegment` 未宣告 `end` 而丟棄該值，不需修改服務端。

## What Changes

- 新增以 YouTube 影片連結為輸入的字幕產生流程：擷取音訊、完成整支轉錄，並產生分段時間軸。
- 僅擷取轉錄所需音訊，不下載或保留視訊內容。
- `LocalServerSegment` 解析服務端既有的 `end` 欄位。
- 新增 VoxNote 獨立播放視窗，以 YouTube IFrame Player API 播放已處理影片。
- 字幕以播放器的實際播放時間為唯一同步基準；暫停、緩衝、跳轉與播放速度變更皆自然反映於字幕。
- 影片禁止嵌入或播放器載入失敗時，明確告知，並提供以系統預設瀏覽器開啟原始影片的操作；外部瀏覽器不提供同步字幕。
- 處理結果獨立落盤，不混入會議記錄，並可由使用者主動產生摘要。
- 僅支援已存在且可存取的 YouTube 影片，不支援直播與其他影片平台。

**移除的原規劃**：

- 不提供外部播放器搭配浮動字幕視窗的模式。
- 不提供手動對齊、獨立字幕計時器或字幕的手動暫停／繼續。
- 不與即時字幕共用 overlay，也不新增兩者互斥規則。
- 不提供瀏覽器選擇器或外部瀏覽器播放狀態整合。

## Capabilities

### New Capabilities

- `video-url-subtitle`: 預先處理 YouTube 影片音訊，並於 VoxNote 獨立內嵌播放視窗中顯示自動同步字幕。

### Modified Capabilities

<!-- 無。即時字幕能力不受本變更影響。 -->

## Design Decisions

### 為何限制為 YouTube

`yt-dlp` 可擷取許多網站的音訊，不代表這些網站都提供可嵌入且能讀取播放進度的播放器 API。第一版限定 YouTube，才能以官方 IFrame Player API 取得可靠播放時間與狀態，而不是為各平台建立不同整合。

### 為何不是即時字幕模式

基準 `live-caption-overlay` 要求即時字幕不落盤，本能力則必須儲存處理結果；兩者的資料生命週期與轉錄方式均不同。本變更不修改即時字幕能力。

### 與 `add-async-transcription-queue` 的關係

長影片與長會議錄音同樣需要非同步任務與進度回報。本變更 MUST NOT 另建第二套任務機制，應沿用該變更的批次轉錄佇列。建議於 `add-async-transcription-queue` 完成後實作。

### 時間軸來源

字幕時間軸 MUST 使用轉錄後端回傳的分段 `start`／`end`，MUST NOT 依字數或語速推算。同步時直接讀取 YouTube 播放器時間，不另維護可能漂移的本機播放時鐘。

## Impact

**新增檔案**

- `src-tauri/src/video_subtitle/mod.rs`：YouTube URL 解析、音訊擷取與字幕時間軸組裝。
- `src-tauri/src/commands/video_subtitle_cmds.rs`：影片字幕相關 Tauri commands。
- `src/pages/videoSubtitle.ts`：影片項目與處理介面。
- 獨立播放視窗所需的本地 HTML／TypeScript 入口，實際檔名依既有 Vite 多頁面慣例決定。

**修改既有檔案**

- `src-tauri/src/asr/mod.rs`：`LocalServerSegment` 新增 `end`。
- `src-tauri/src/config/mod.rs` 與 `src/types/index.ts`：新增必要型別與設定。
- `src-tauri/tauri.conf.json` 與 `src-tauri/capabilities/`：註冊 sidecar、播放視窗及最小權限。
- 資料庫 schema：新增與 `meetings` 分離的影片字幕資料表。

**外部相依**

- `yt-dlp` Tauri sidecar，用於取得 YouTube 音訊與必要中繼資料。
- `tauri-plugin-shell`，權限僅限已註冊的 sidecar，不開放任意命令。
- YouTube IFrame Player API，用於內嵌播放及讀取播放狀態。
- 優先讓既有轉錄服務處理音訊格式；只有前置驗證證明不可行時才加入客戶端 ffmpeg。

**不需修改**

- `server/app.py`：已輸出 `end`。
- `live-caption-overlay`：不共用其視窗與 session。

**平台與使用限制**

- YouTube 影片擁有者可禁止嵌入；此時只能以預設瀏覽器開啟，無同步字幕。
- 不處理需登入、私人、受地區限制或 DRM 保護而無法取得音訊的影片。
- 本功能供使用者個人使用，不提供批次下載或內容散布。
