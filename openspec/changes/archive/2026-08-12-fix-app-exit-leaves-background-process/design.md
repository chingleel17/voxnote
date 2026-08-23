## Context

見 proposal.md - Why。目前 `src-tauri/src/lib.rs` 未註冊任何 `on_window_event`／`CloseRequested` 處理，主視窗關閉不會觸發任何收尾邏輯。

現有可複用的停止機制：
- `live_caption::LiveCaptionManager::stop(&self, app: &AppHandle) -> Result<()>`（`src-tauri/src/live_caption/mod.rs:275`）：已實作「送出停止訊號、`join()` 背景執行緒、關閉/隱藏 overlay」的邏輯，是 `stop_live_caption` command 目前呼叫的核心函式。
- `audio_recording::stop_recording(&DesktopRecordingManager) -> Result<RecordingPreview>` 與 `cancel_recording(&DesktopRecordingManager) -> Result<()>`（`src-tauri/src/audio_recording/mod.rs:232`、`242`）：分別對應「停止並保留錄音」與「取消並捨棄錄音」，是 `stop_desktop_recording` / `cancel_desktop_recording` command 呼叫的核心函式。

兩者的狀態（`running: Arc<AtomicBool>`、session 是否存在）都保存在透過 `app_handle.manage()` 注入的 state（`LiveCaptionManager`、`DesktopRecordingManager`），在 `on_window_event` handler 中可用 `app.state::<T>()` 取得，不需要額外傳遞。

`live_caption::mod.rs:1041` 的 `close_overlay()` 目前呼叫 `window.hide()`，這是既有「session 結束後保留視窗供下次顯示」的設計（見程式碼註解），沿用即可——因為只要收尾流程最終呼叫 `app.exit(0)`，隱藏視窗是否仍存在不影響進程終止（`app.exit()` 直接結束進程，不等待「所有視窗關閉」事件）。這比修改 `close_overlay()` 語意更小侵入性。

## Goals / Non-Goals

**Goals:**
- 主視窗 `CloseRequested` 時，同步完成即時字幕與桌面錄音的停止收尾。
- 收尾後透過 `app.exit(0)` 保證進程終止，不依賴「所有視窗已關閉」的預設 Tauri 行為。
- 錄音進行中關閉時，保留已錄製資料（呼叫 `stop_recording` 而非 `cancel_recording`）。

**Non-Goals:**
- 不改變使用者主動點擊「停止字幕」「停止錄音」按鈕的既有行為與 command 介面。
- 不處理系統關機/登出（`WM_QUERYENDSESSION`）等其他生命週期事件，僅處理使用者關閉主視窗。
- 不新增系統匣（tray）常駐或「最小化到背景」功能。

## Decisions

### 1. 攔截點：`on_window_event`，僅比對主視窗 label

在 `lib.rs` 的 `Builder` 上加入 `.on_window_event(|window, event| { ... })`，並僅在 `window.label() == "main"` 且 `event` 為 `WindowEvent::CloseRequested` 時執行收尾。

替代方案考慮過在 `overlay` 視窗上也攔截，但 overlay 只是輔助顯示視窗，不應由它的關閉觸發整體收尾；且使用者關閉 overlay 目前沒有對應 UI（`skipTaskbar: true`、無視窗控制按鈕），故只需處理 `main`。

### 2. 收尾流程：呼叫 `event.prevent_default()`、同步執行收尾、最後 `app.exit(0)`

流程：
1. `api.prevent_default()`，避免視窗立即關閉導致收尾中應用程式已無畫面但進程未結束的中間態不可控。
2. 若 `LiveCaptionManager` 顯示有 session 進行中，呼叫既有 `manager.stop(&app_handle)`。
3. 若 `DesktopRecordingManager` 顯示有錄音進行中，呼叫既有 `audio_recording::stop_recording(&manager)`（保留資料，符合 proposal 「不得遺失已錄製內容」的要求）。
4. 兩者收尾函式內部已是同步阻塞（`thread.join()`），完成後直接呼叫 `app_handle.exit(0)`。

兩個停止呼叫都直接複用現有 command 使用的函式，避免重複實作停止邏輯或讓兩處邏輯漂移。

替代方案考慮過「不 `prevent_default`，讓視窗先關閉，收尾在背景非同步進行，最後才 `exit`」：會讓使用者以為程式已關閉但背景仍在寫檔，若此時使用者又執行安裝程式，仍會撞到殘留進程問題（與本次要解決的问题相同），故不採用。

### 3. 錯誤處理：收尾失敗不得阻止進程退出

`manager.stop()` 或 `stop_recording()` 若回傳 `Err`（例如裝置已離線、鎖已釋放等邊界情況），僅記錄錯誤（沿用專案 log 慣例），不中斷收尾流程，仍繼續呼叫 `app.exit(0)`。理由：關閉流程的首要目標是保證進程終止；停止子系統失敗不應讓使用者卡在「無法關閉應用程式」的更差體感。

## Risks / Trade-offs

- [風險] 收尾流程中 `join()` 背景執行緒可能有延遲（例如錄音落盤需要時間），導致使用者點擊關閉後視窗有短暫停頓才消失。
  → 緩解：現有 `stop()`/`stop_recording()` 執行緒設計已是快速回應停止訊號（輪詢間隔短），與使用者主動點擊「停止」按鈕時的等待時間一致，不是新增的延遲來源。

- [風險] 若未來新增其他長駐背景執行緒（新的音訊來源、新的 AI 任務等），忘記在收尾流程中一併停止，會重蹈本次問題。
  → 緩解：`app.exit(0)` 是最終保底手段——即使忘記停止某個背景執行緒，只要收尾流程本身有跑到 `exit(0)`，OS 仍會強制結束進程（`exit(0)` 不等待其他執行緒），不會重現「安裝程式偵測到殘留進程」的問題。真正需要留意的是「資料是否來得及落盤」，這點僅對錄音／字幕儲存邏輯適用，已在本次涵蓋。

## Migration Plan

無資料遷移。純行為修正，於下一個版本發布即生效。建議在發布前手動驗證：啟動即時字幕→關閉主視窗→工作管理員確認 `voxnote.exe` 已結束；錄音中關閉主視窗→重啟應用程式確認錄音已保存。
