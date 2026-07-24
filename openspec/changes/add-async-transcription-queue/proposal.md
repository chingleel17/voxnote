## Why

`voxnote_asr` 服務端目前為單發同步：`POST /v1/audio/transcriptions` 會等到整段轉錄與語者分離跑完才回傳。一場長會議的處理可能達數分鐘，容易觸發 HTTP 逾時而中斷，且過程中無法回報進度，使用者只能空等。中研院 TranscriptHub 等成熟轉錄服務均採「建立任務 → 輪詢狀態」的非同步模式；本 change 為 `voxnote_asr` 加入輕量非同步任務佇列與進度回報，並讓 app 端呼叫方式與既有 AssemblyAI 的輪詢流程收斂一致。

## What Changes

- 服務端 `POST /v1/audio/transcriptions` 改為**非同步**：立即回傳 `task_id`，實際轉錄於背景執行。
- 新增 `GET /v1/tasks/{task_id}` 查詢任務狀態（`queued` / `processing` / `done` / `failed`）、進度與結果。
- 服務端以**記憶體任務表 + FastAPI BackgroundTasks** 實作（單機服務足夠；不引入資料庫或 Celery，遵循 YAGNI）；同一時間循序處理，避免 GPU 並行導致 OOM。
- app 端 `transcribe_voxnote_asr` 改為「建立任務 → 輪詢」流程，複用既有 `asr_progress` 事件回報進度，與 `transcribe_assemblyai` 的模式一致。
- **BREAKING（僅限 voxnote_asr 服務端 API 契約）**：同步回傳格式改為非同步 `task_id`；因該服務尚未實機上線，無既有使用者受影響。

明確不做（YAGNI）：不引入外部資料庫或訊息佇列中介軟體；不做多 worker 平行轉錄；不做任務持久化（服務重啟後記憶體任務清空，符合單機情境）。

## Capabilities

### New Capabilities
- `async-transcription-queue`: 以非同步任務佇列處理長音訊轉錄，提供任務建立、狀態查詢與進度回報。

### Modified Capabilities
- `local-asr-server`: 轉錄端點由單發同步改為非同步任務模式，回傳 `task_id` 而非直接回傳逐字稿。

## Impact

- **服務端**：`server/app.py` 新增任務表、`GET /v1/tasks/{id}` 端點，`POST /v1/audio/transcriptions` 改為背景執行；`server/README.md` 更新 API 說明。
- **app 端 Rust**：`src-tauri/src/asr/mod.rs` 的 `transcribe_voxnote_asr` 改為建任務+輪詢邏輯。
- **相依性**：不新增外部相依（FastAPI BackgroundTasks 為內建）。
- **前置依賴**：本 change 應於 `add-local-breeze-asr-service` 完成實機驗證（Breeze 品質、語者分離可行性）後再實作，避免在未驗證的核心上疊加架構。
