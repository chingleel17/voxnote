## Purpose

定義本地 ASR 伺服器的非同步轉錄任務佇列、任務狀態查詢、循序處理與進度回報能力，讓長音訊轉錄可避免請求逾時並讓客戶端掌握處理進度。

## Requirements

### Requirement: 非同步任務建立

服務端 SHALL 於接收轉錄請求後立即建立任務並回傳 `task_id`，實際轉錄於背景執行，不阻塞請求。

#### Scenario: 建立轉錄任務

- **WHEN** 客戶端 POST 音訊至轉錄端點
- **THEN** 服務端 SHALL 立即回傳含 `task_id` 與初始狀態 `queued` 的回應，並於背景開始處理

### Requirement: 任務狀態查詢

服務端 SHALL 提供 `GET /v1/tasks/{task_id}` 端點，回報任務的狀態、進度與（完成時的）結果。

任務狀態 SHALL 包含 `queued`、`processing`、`done` 與 `failed`。處理中的任務 SHALL 回報可用的進度資訊；完成的任務 SHALL 回報完整轉錄結果；失敗的任務 SHALL 回報繁體中文錯誤訊息。

#### Scenario: 查詢處理中的任務

- **WHEN** 客戶端查詢一個仍在處理的 `task_id`
- **THEN** 服務端 SHALL 回傳狀態 `processing` 與可用的進度資訊

#### Scenario: 查詢已完成的任務

- **WHEN** 客戶端查詢一個已完成的 `task_id`
- **THEN** 服務端 SHALL 回傳狀態 `done` 與完整轉錄結果（含分段時間戳與語者標籤）

#### Scenario: 查詢失敗的任務

- **WHEN** 轉錄過程發生錯誤
- **THEN** 對應任務狀態 SHALL 為 `failed`，並附繁體中文錯誤訊息

#### Scenario: 查詢不存在的任務

- **WHEN** 客戶端查詢不存在的 `task_id`
- **THEN** 服務端 SHALL 回傳 404 與明確錯誤訊息

### Requirement: 循序處理避免資源耗盡

服務端 SHALL 循序處理轉錄任務，同一時間至多執行一個轉錄，避免 GPU 記憶體因並行而耗盡。

#### Scenario: 多任務排隊

- **WHEN** 前一任務尚在處理時又建立新任務
- **THEN** 新任務狀態 SHALL 為 `queued`，待前一任務完成後才開始處理
