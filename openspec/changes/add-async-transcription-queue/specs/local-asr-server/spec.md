## MODIFIED Requirements

### Requirement: 透過 OpenAI 相容端點進行轉錄

系統 SHALL 以 HTTP multipart 上傳音訊檔至伺服器的 `/v1/audio/transcriptions` 端點。該端點採非同步任務模式：立即回傳 `task_id`，客戶端 SHALL 透過任務狀態查詢端點取得最終逐字稿結果。

#### Scenario: 成功建立轉錄任務

- **WHEN** 音訊檔成功上傳
- **THEN** 系統 SHALL 立即回傳 `task_id`，並於背景執行轉錄；客戶端 SHALL 輪詢任務狀態直至完成後取得逐字稿

#### Scenario: 伺服器不可達或回傳錯誤

- **WHEN** 伺服器連線失敗、逾時或回傳非成功狀態碼
- **THEN** 系統 SHALL 回傳含伺服器錯誤內容的明確錯誤訊息，且 SHALL NOT 產生空白逐字稿
