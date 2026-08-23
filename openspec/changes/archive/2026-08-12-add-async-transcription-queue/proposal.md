## Why

`voxnote_asr` 服務端目前為單發同步：`POST /v1/audio/transcriptions` 會等到整段轉錄與語者分離跑完才回傳。一場長會議的處理可能達數分鐘，容易觸發 HTTP 逾時而中斷，且過程中無法回報進度，使用者只能空等。中研院 TranscriptHub 等成熟轉錄服務均採「建立任務 → 輪詢狀態」的非同步模式；本 change 為 `voxnote_asr` 加入輕量非同步任務佇列與進度回報，並讓 app 端呼叫方式與既有 AssemblyAI 的輪詢流程收斂一致。

## What Changes

- 服務端 `POST /v1/audio/transcriptions` 改為**非同步**：立即回傳 `task_id`，實際轉錄於背景執行。
- 新增 `GET /v1/tasks/{task_id}` 查詢任務狀態（`queued` / `processing` / `done` / `failed`）、進度與結果。
- 服務端以**記憶體任務表 + FastAPI BackgroundTasks** 實作（單機服務足夠；不引入資料庫或 Celery，遵循 YAGNI）；同一時間循序處理，避免同一實例內並行轉錄導致 OOM。**此序列化為 per-instance**：同一套程式碼會以不同 `ASR_MODEL` 部署多個實例（批次用 Breeze、即時字幕用英文模型），跨實例的 GPU 算力與記憶體爭用不在此鎖的涵蓋範圍，屬部署層面的取捨。
- app 端 `transcribe_voxnote_asr` 改為「建立任務 → 輪詢」流程，複用既有 `asr_progress` 事件回報進度，與 `transcribe_assemblyai` 的模式一致。
- **保留同步模式供即時字幕使用**：轉錄端點同時支援由呼叫方指定的同步回應。理由：模型由 `ASR_MODEL` 環境變數決定（`server/app.py:154-158`），故供即時字幕使用的實例與批次用的 Breeze 實例**是同一套程式碼**，僅模型不同——本變更改動端點契約時會一併影響即時字幕所用的實例。若一律改為非同步，即時字幕以數秒音訊視窗呼叫時將被迫「建任務→輪詢」，其往返開銷與該節奏不相稱。同步與非同步共用同一轉錄邏輯，不另建實作。

  部署上兩個實例經 gateway 於單一埠以 `/batch/`、`/live/` 路徑分流（見 `server/nginx.conf`），但**分流不改變契約問題**：兩者跑的仍是同一份 `app.py`，故同步模式仍為必要。
- **BREAKING（僅限 voxnote_asr 服務端 API 契約）**：預設回傳格式由逐字稿改為 `task_id`；因該服務尚未實機上線，無既有使用者受影響。指定同步模式者不受影響。

明確不做（YAGNI）：不引入外部資料庫或訊息佇列中介軟體；不做多 worker 平行轉錄；不做任務持久化（服務重啟後記憶體任務清空，符合單機情境）。

## Capabilities

### New Capabilities
- `async-transcription-queue`: 以非同步任務佇列處理長音訊轉錄，提供任務建立、狀態查詢與進度回報。

### Modified Capabilities
- `local-asr-server`: 轉錄端點由單發同步改為非同步任務模式，回傳 `task_id` 而非直接回傳逐字稿。

## Impact

- **服務端**：`server/app.py` 新增任務表、`GET /v1/tasks/{id}` 端點，`POST /v1/audio/transcriptions` 改為背景執行並保留由呼叫方指定的同步模式；`server/README.md` 更新 API 說明。
- **gateway**：`server/nginx.conf` 需為新增的 `GET /v1/tasks/{id}` 確認轉發正常（既有 `location /batch/`、`/live/` 為前綴比對，新端點自動涵蓋，無須新增規則）。輪詢請求為短連線，不受批次的 3600 秒 `proxy_read_timeout` 影響。
- **app 端 Rust**：`src-tauri/src/asr/mod.rs` 的 `transcribe_voxnote_asr` 改為建任務+輪詢邏輯；即時字幕路徑維持同步（見任務 2.1 的共用 helper 注意事項）。
- **相依性**：不新增外部相依（FastAPI BackgroundTasks 為內建）。
- **前置依賴**：`add-local-breeze-asr-service` 已於 2026-08-03 歸檔（Breeze 品質與語者分離已實機驗證），本前置條件已滿足。
