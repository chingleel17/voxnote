# Proposal

## Why

v0.1.5 要把 macOS 從「有建置目標但未驗證」提升為可安裝、可錄音與產生字幕的支援平台。現有程式缺少 macOS 系統音訊擷取與權限處理，僅提供麥克風或通過編譯不足以達成使用者期待。

## What Changes

- **BREAKING（macOS 平台基準）**：最低版本由 README 原先列出的 macOS 12+ 改為 macOS 13+，以支援 ScreenCaptureKit 系統音訊；Windows 最低版本不變。
- 提供 Apple Silicon（aarch64）與 Intel（x86_64）的 `.app`／`.dmg`，先採 ad-hoc 簽署；目前無 Apple Developer 帳號，不宣稱 Developer ID 簽署或 Apple 公證。
- 支援 Mac 麥克風、全系統播放音訊及兩者混音，沿用停止預覽、儲存、轉錄、校稿與摘要流程。
- 即時字幕可選 Mac 系統音訊或麥克風，重用本地 Whisper CPU／遠端 ASR 管線及字幕浮動視窗。
- 增加 macOS 隱私用途說明、權限檢查、拒絕／撤銷後的復原指引與原生資源釋放。
- 隔離 Windows 相依，補齊 Mac 原生橋接、CI、發行驗證與 README 平台矩陣；用隔離示範資料擷取真實 Mac 畫面。

## Capabilities

### New Capabilities

- `macos-desktop-distribution`：Mac 最低版本、雙架構安裝包、ad-hoc 發行、核心功能與發布驗收。
- `macos-audio-permissions`：麥克風及系統音訊權限的請求時機、拒絕／撤銷與復原行為。

### Modified Capabilities

- `desktop-system-audio-capture`：新增 Mac 全系統音訊擷取，混音支援 Windows 與 Mac。
- `recording-source-selection`：依平台列出正確來源，Mac 系統來源不冒充 Windows 輸出裝置。
- `live-caption-overlay`：Mac 系統音訊與麥克風的來源支援及明確失敗行為。

## Impact

- Rust：`Cargo.toml`、`build.rs`、`audio_recording/`、`live_caption/`、相關 commands；新增 macOS 原生橋接。不變更資料庫 schema。
- Tauri：macOS 專用設定、Info.plist、必要 entitlements／透明浮窗設定、capabilities；前端同步來源型別與錯誤顯示，維持 API 封裝。
- 發行：macOS 雙架構 CI、`.app`／`.dmg`、Windows 回歸、README 與 CHANGELOG；目前 v0.1.5 文件仍屬待發布準備，不代表此功能已完成。
- 與 `add-live-caption-process-audio` 的 Windows 指定應用程式擷取分開；不包含 Mac 指定應用程式、影片網址字幕或 yt-dlp sidecar。增量字幕 change 的解碼／顯示政策不在此重定義，只增加音訊來源接入。
