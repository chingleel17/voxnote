## Why

主視窗關閉後，`voxnote.exe` 進程可能仍殘留在背景：Tauri 未攔截主視窗 `CloseRequested` 事件，若即時字幕曾啟動過（隱藏的 overlay 視窗仍存在）或 `live_caption`／`audio_recording` 的背景執行緒仍在 `running` 狀態，進程不會自動結束。使用者實測發現，即使已手動關閉應用程式視窗，安裝程式仍持續提示「請先關閉應用程式」，且工作管理員可查到 `voxnote.exe` 仍在執行。此問題會導致更新/安裝失敗、資源占用，且錄音或字幕進行中若被強制終止還有資料遺失風險，需要明確收尾流程。

## What Changes

- 在 `src-tauri/src/lib.rs` 註冊主視窗 `on_window_event`，攔截 `CloseRequested`。
- 關閉時依序執行收尾：若即時字幕 session 進行中，先停止 `live_caption` 背景執行緒（設定 `running=false` 並送出停止訊號、`join()` 等待執行緒結束）；若桌面錄音進行中，先停止 `audio_recording` 背景執行緒並確保錄音資料已落盤/儲存，避免資料遺失。
- 顯式關閉／銷毀隱藏的 `live-caption-overlay` 視窗（而非僅 `hide()`），確保 Tauri 判定「所有視窗已關閉」。
- 收尾完成後呼叫 `app.exit(0)` 強制結束進程，避免任何殘留背景執行緒導致 process 不退出。
- 收尾過程避免阻塞 UI 過久：對執行緒 `join()` 設定合理的處理方式（沿用現有同步 `join()` 模式，執行緒本身應能在收到停止訊號後快速退出）。

## Capabilities

### New Capabilities
- `app-lifecycle-shutdown`: 應用程式關閉時的收尾與進程終止行為——攔截主視窗關閉、停止背景任務（即時字幕、桌面錄音）、關閉隱藏視窗、確保進程完全退出。

### Modified Capabilities
- `live-caption-overlay`: 新增「應用程式關閉時」的行為需求——即時字幕 session 進行中若應用程式被關閉，需先停止背景執行緒與擷取迴圈，而非讓視窗保持隱藏狀態導致進程不退出。

## Impact

- 受影響程式碼：`src-tauri/src/lib.rs`（新增 window event handler）、`src-tauri/src/live_caption/mod.rs`（提供可從外部呼叫的停止函式，或複用既有 `stop_live_caption` 邏輯）、`src-tauri/src/audio_recording/mod.rs`（提供可從外部呼叫的停止/落盤函式）。
- 不影響資料庫 schema、既有 Tauri command 介面。
- 使用者體感：關閉主視窗後應用程式完全結束，安裝/更新流程不再誤判應用程式仍在執行；若錄音或字幕進行中關閉，資料應正常保存而非遺失。
