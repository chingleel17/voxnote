## Why

目前錄音頁只透過瀏覽器的 `getUserMedia()` 與 `MediaRecorder` 擷取麥克風，當使用者在線上會議中配戴耳機時，會議聲音不會進入錄音檔，造成逐字稿與摘要缺少遠端發言內容。現在補上電腦本地音訊擷取與混音能力，可以先解決遠距會議紀錄不完整的問題，也能為後續影片檔匯入、翻譯與摘要共用同一條音訊處理管線。

## What Changes

- 在錄音頁新增錄音來源模式，支援「僅麥克風」、「僅電腦音訊」與「麥克風 + 電腦音訊混音」。
- 將桌面錄音能力下放到 Tauri/Rust，於 Windows 透過系統音訊 loopback 擷取播放中的本地音訊，並與選定的麥克風輸入混成單一音檔。
- 補上桌面音訊裝置列舉、來源可用性檢查、錄音失敗提示與停止後預覽/儲存流程，維持既有逐字稿、校稿與摘要流程可直接沿用。
- 為未來影片檔匯入與離線轉譯預留可重用的音訊輸入抽象，但本次不包含影片檔 UI 與字幕功能。

## Capabilities

### New Capabilities
- `recording-source-selection`: 定義錄音頁如何讓使用者選擇麥克風、電腦音訊或混音模式，並在來源不可用時提供可執行的提示。
- `desktop-system-audio-capture`: 定義桌面端如何擷取 Windows 本地音訊、與麥克風混音、產出可沿用既有流程的錄音檔。

### Modified Capabilities
- 無

## Impact

- 前端錄音頁與型別：`src/pages/record.ts`、`src/api/recordings.ts`、`src/types/index.ts`
- Tauri command 與應用註冊：`src-tauri/src/commands/`、`src-tauri/src/lib.rs`
- 設定與桌面音訊擷取模組：`src-tauri/src/config/` 與新的錄音/音訊模組
- 可能新增 Rust 相依套件，用於裝置列舉、WAV 寫入、Windows WASAPI loopback 與混音緩衝
