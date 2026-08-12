## 1. 收尾邏輯實作

- [x] 1.1 在 `src-tauri/src/lib.rs` 的 `Builder` 加入 `.on_window_event(...)`，比對 `window.label() == "main"` 且事件為 `WindowEvent::CloseRequested`
- [x] 1.2 收尾 handler 中呼叫 `api.prevent_default()`，取得 `app_handle`、`LiveCaptionManager` 與 `DesktopRecordingManager` 的 state
- [x] 1.3 若即時字幕 session 進行中，呼叫 `LiveCaptionManager::stop(&app_handle)`；錯誤僅記錄，不中斷後續流程
- [x] 1.4 若桌面錄音進行中，呼叫 `audio_recording::stop_recording(&manager)` 保留已錄製資料；錯誤僅記錄，不中斷後續流程
- [x] 1.5 收尾流程結束後呼叫 `app_handle.exit(0)` 強制終止進程

## 2. 驗證

- [x] 2.1 手動測試：無任何背景任務時關閉主視窗，確認 `voxnote.exe` 於工作管理員中完全結束
- [x] 2.2 手動測試：啟動即時字幕後關閉主視窗，確認字幕浮動視窗消失、`voxnote.exe` 完全結束
- [x] 2.3 手動測試：啟動桌面錄音後關閉主視窗，重啟應用程式確認錄音已保存於清單中，且 `voxnote.exe` 於關閉當下即完全結束
- [x] 2.4 手動測試：曾經啟動又停止即時字幕（overlay 曾顯示又隱藏）後關閉主視窗，確認 `voxnote.exe` 完全結束
- [x] 2.5 執行既有 Rust 測試套件（`cargo test`），確認未破壞既有行為

## 3. 文件與規格同步

- [x] 3.1 確認 `openspec validate fix-app-exit-leaves-background-process --type change --strict` 通過
- [x] 3.2 視情況更新 README 或相關文件，補充「關閉應用程式會等待背景任務收尾」的行為說明（若使用者體感有明顯延遲）
