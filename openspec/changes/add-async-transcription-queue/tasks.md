> 前置依賴：本 change 應於 `add-local-breeze-asr-service` 完成實機驗證（Breeze 品質、語者分離可行性）後再實作。

## 1. 服務端任務佇列

- [ ] 1.1 在 `server/app.py` 新增記憶體任務表（`task_id` → 狀態/進度/結果/錯誤訊息），狀態列舉 `queued`/`processing`/`done`/`failed`
- [ ] 1.2 加入 asyncio 鎖或單一背景工作，確保同一時間至多一個轉錄執行（排隊任務標記 `queued`）
- [ ] 1.3 將 `POST /v1/audio/transcriptions` 改為建立任務、以 BackgroundTasks 背景執行，立即回傳 `task_id` 與初始狀態
- [ ] 1.4 轉錄流程三階段（轉錄／對齊／語者分離）更新任務進度（0/33/66/100）
- [ ] 1.5 背景執行以 try/except 包覆，例外時標記任務 `failed` 並記錄繁體中文錯誤訊息
- [ ] 1.6 新增 `GET /v1/tasks/{task_id}`：回傳狀態、進度與（完成時）結果；不存在時回 404
- [ ] 1.7 完成任務保留策略（如完成後一段時間或超過筆數上限清除），避免記憶體無限增長

## 2. app 端整合（Rust）

- [ ] 2.1 `src-tauri/src/asr/mod.rs` 的 `transcribe_voxnote_asr` 改為：POST 建任務取得 `task_id`
- [ ] 2.2 實作輪詢 `GET /v1/tasks/{id}`，依狀態透過既有 `asr_progress` 事件回報進度，輪詢間隔比照 `transcribe_assemblyai`
- [ ] 2.3 任務 `done` 時取結果並沿用既有格式化為 `[MM:SS 講者X] text`；`failed` 時回傳明確錯誤
- [ ] 2.4 處理輪詢逾時與伺服器中途不可達的降級提示

## 3. 文件與驗證

- [ ] 3.1 更新 `server/README.md` 的 API 說明（非同步契約、`GET /v1/tasks/{id}`）
- [ ] 3.2 以長音訊端到端測試：不逾時、進度正確回報、結果正確
- [ ] 3.3 失敗路徑測試：轉錄錯誤標記 `failed`、查詢不存在任務回 404、輪詢逾時降級
