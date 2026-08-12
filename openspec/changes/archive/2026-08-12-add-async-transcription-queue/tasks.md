> 前置依賴已滿足：`add-local-breeze-asr-service` 已於 2026-08-03 歸檔，Breeze 品質與語者分離皆已實機驗證。
>
> 注意：服務端已改為雙實例＋gateway 部署（`server/docker-compose.yml`、`server/nginx.conf`）。
> 兩個實例跑同一份 `app.py`，故本變更的契約改動會同時影響批次與即時字幕，
> 這是任務 1.3.1 保留同步模式的原因。

## 1. 服務端任務佇列

- [x] 1.1 在 `server/app.py` 新增記憶體任務表（`task_id` → 狀態/進度/結果/錯誤訊息），狀態列舉 `queued`/`processing`/`done`/`failed`
- [x] 1.2 加入 asyncio 鎖或單一背景工作，確保同一時間至多一個轉錄執行（排隊任務標記 `queued`）
- [x] 1.3 將 `POST /v1/audio/transcriptions` 改為建立任務、以 BackgroundTasks 背景執行，立即回傳 `task_id` 與初始狀態
- [x] 1.3.1 新增由呼叫方指定的**同步模式**（供即時字幕使用）：於該次請求內完成轉錄並直接回傳逐字稿，與非同步共用同一轉錄邏輯與輸出格式
- [x] 1.3.2 確認同步模式不經任務表與 BackgroundTasks，避免即時呼叫承擔排隊延遲
- [x] 1.4 轉錄流程三階段（轉錄／對齊／語者分離）更新任務進度（0/33/66/100）
- [x] 1.5 背景執行以 try/except 包覆，例外時標記任務 `failed` 並記錄繁體中文錯誤訊息
- [x] 1.6 新增 `GET /v1/tasks/{task_id}`：回傳狀態、進度與（完成時）結果；不存在時回 404
- [x] 1.7 完成任務保留策略（如完成後一段時間或超過筆數上限清除），避免記憶體無限增長

## 2. app 端整合（Rust）

- [x] 2.1 `src-tauri/src/asr/mod.rs` 的 `transcribe_voxnote_asr` 改為：POST 建任務取得 `task_id`
  - **注意共用 helper**：`transcribe_voxnote_asr`（:205）與即時字幕用的 `transcribe_voxnote_asr_samples`（:235）皆走同一個 `transcribe_voxnote_asr_bytes`（:252）。本任務只改批次路徑為非同步，即時路徑 MUST 維持同步（走 1.3.1 的同步模式）。若因此使 helper 的參數分歧，應拆分而非讓即時路徑被迫非同步。
- [x] 2.1.1 確認 `transcribe_voxnote_asr_bytes` 於兩條路徑分離後是否成為死碼或可內聯（與 remote-asr 任務 2.7 一併檢視）
- [x] 2.2 實作輪詢 `GET /v1/tasks/{id}`，依狀態透過既有 `asr_progress` 事件回報進度，輪詢間隔比照 `transcribe_assemblyai`
- [x] 2.3 任務 `done` 時取結果並沿用既有格式化為 `[MM:SS 講者X] text`；`failed` 時回傳明確錯誤
- [x] 2.4 處理輪詢逾時與伺服器中途不可達的降級提示

## 3. 文件與驗證

- [x] 3.1 更新 `server/README.md` 的 API 說明（非同步契約、`GET /v1/tasks/{id}`）
- [x] 3.2 以長音訊端到端測試：不逾時、進度正確回報、結果正確
- [x] 3.2.1 經 gateway 測試：`/batch/v1/tasks/{id}` 輪詢可正常轉發，且長批次不因 gateway 逾時被切斷
- [x] 3.2.2 確認即時字幕經 `/live/` 走同步模式仍正常，未被非同步化影響
- [x] 3.3 失敗路徑測試：轉錄錯誤標記 `failed`、查詢不存在任務回 404、輪詢逾時降級
