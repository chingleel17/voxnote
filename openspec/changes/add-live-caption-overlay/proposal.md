## Why

目前 VoxNote 的逐字稿流程全為「錄完整段音訊 → 整檔送轉錄 → 事後閱讀」的批次模式，無法在聲音正在播放的當下提供文字輔助。使用者觀看沒有字幕（或僅有外語字幕）的影片、參加線上會議時，需要一個能即時把電腦聲音轉成繁體中文字幕、並疊在畫面上的工具。

此需求已列於專案未來規劃（系統聲音擷取、即時字幕生成、翻譯字幕），本變更為其第一階段落地。

## What Changes

- 新增「即時字幕」模式：擷取電腦系統音訊（或麥克風），以滑動視窗分段送轉錄，將結果即時顯示為字幕。
- 新增獨立的即時字幕浮動視窗：無邊框、永遠置頂、可拖曳與調整大小，供使用者疊放於影片播放器上方。
- 轉錄後端支援兩種可切換的來源：本地 whisper 引擎（以 `whisper-rs` 在應用程式內載入 GGML 模型，低延遲、零成本、不對外傳送音訊）與既有自架 ASR 服務（Breeze-ASR，繁中品質較佳）。
- 新增字幕翻譯：轉錄結果經既有 `call_llm()` 譯為繁體中文台灣用語後顯示，可於設定中關閉。
- 新增即時字幕相關設定項（後端選擇、本地模型檔路徑、視窗大小、字級、是否翻譯、是否顯示原文）。
- 即時字幕為**純即時、不持久化**：不寫入資料庫、不產生錄音檔，關閉即消失。
- 即時字幕**不提供語者分離**。分段轉錄無法維持跨段一致的語者身分，既有批次逐字稿的語者分離功能不受影響。

本變更不修改任何既有錄音、逐字稿、校稿或摘要流程的行為，無 breaking change。

## Capabilities

### New Capabilities
- `live-caption-overlay`: 即時字幕的擷取、分段轉錄、翻譯與浮動視窗顯示行為，含啟停生命週期與失敗處理。

### Modified Capabilities
<!-- 無。即時字幕以獨立 session 管理器實作，不改變 desktop-system-audio-capture、recording-source-selection、local-asr-server 既有需求的行為。 -->

## Impact

**新增程式碼**
- `src-tauri/src/live_caption/`：即時字幕 session 管理器（音訊擷取消費、視窗分段、轉錄與翻譯派送、事件推送）。
- `src-tauri/src/commands/live_caption_cmds.rs`：啟動、停止、狀態查詢等 Tauri command。
- `src/pages/liveCaption.ts`、`src/api/liveCaption.ts`：主視窗的控制面板與 invoke 封裝層。
- 字幕浮動視窗的獨立前端進入點（HTML + TS）。

**修改既有檔案**
- `src-tauri/src/lib.rs`：註冊新的 command 與 session 管理器 state。
- `src-tauri/src/audio_recording/mod.rs`：將 WASAPI loopback 擷取與降取樣邏輯抽出為可重用單元，供即時字幕沿用；既有錄音行為不變。
- `src-tauri/src/asr/mod.rs`：新增分段轉錄用的呼叫路徑（本地 whisper 引擎整合）。
- `src-tauri/src/config/mod.rs` 與 `src/types/index.ts`：新增即時字幕設定欄位。
- `src/pages/settings.ts`：新增設定區塊。
- `src-tauri/tauri.conf.json`：宣告字幕浮動視窗。

**外部相依**
- 新增 Rust crate `whisper-rs`（0.16，Unlicense），於應用程式內載入 GGML 模型進行本地轉錄，無須外部執行檔。
- **新增建置工具鏈需求（影響所有開發者與 CI）**：`whisper-rs-sys` 由原始碼建置 whisper.cpp，其 build dependencies 含 `bindgen`（需 LLVM/libclang）與 `cmake`。啟用 CUDA 加速時另需 CUDA Toolkit（`nvcc`）。
- 使用者需自行下載 GGML 模型檔（`.bin`）並於設定中指定路徑；選用自架 ASR 服務時需該服務可連線。

**平台限制**
- 系統音訊擷取沿用既有 WASAPI 實作，**僅支援 Windows**。非 Windows 平台可使用麥克風來源，系統音訊來源不可用。

**不影響**
- 資料庫 schema 無變更（即時字幕不持久化）。
- 既有錄音、轉錄、校稿、摘要、匯出流程不變。
