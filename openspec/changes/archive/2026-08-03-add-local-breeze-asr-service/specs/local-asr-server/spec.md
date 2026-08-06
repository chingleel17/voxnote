## ADDED Requirements

### Requirement: 本地 ASR 伺服器供應商選項

系統 SHALL 提供第三個 ASR 供應商 `voxnote_asr`，與既有的 `assemblyai` 及本地 Whisper CLI（既有字串為 `local`）並列，讓使用者可將轉錄工作導向自架的 OpenAI 相容 ASR 服務。新供應商字串 SHALL NOT 與既有的 `assemblyai`、`local` 衝突。

#### Scenario: 使用者選擇本地伺服器供應商

- **WHEN** 使用者在設定頁將 ASR 供應商設為「本地伺服器」並填入有效的 Base URL
- **THEN** 系統 SHALL 將該設定持久化，且後續轉錄請求 SHALL 送往該伺服器而非 AssemblyAI 或本地 Whisper CLI

#### Scenario: 未設定 Base URL 時的防護

- **WHEN** 供應商為 `voxnote_asr` 但 Base URL 為空
- **THEN** 系統 SHALL 回傳明確錯誤訊息「本地 ASR 伺服器位址未設定」，且 SHALL NOT 送出請求

### Requirement: 透過 OpenAI 相容端點進行轉錄

系統 SHALL 以 HTTP multipart 上傳音訊檔至伺服器的 `/v1/audio/transcriptions` 端點，並解析回傳結果為逐字稿文字。

#### Scenario: 成功轉錄

- **WHEN** 音訊檔成功上傳且伺服器回傳完成狀態
- **THEN** 系統 SHALL 取得逐字稿內容並回傳給呼叫端

#### Scenario: 伺服器不可達或回傳錯誤

- **WHEN** 伺服器連線失敗、逾時或回傳非成功狀態碼
- **THEN** 系統 SHALL 回傳含伺服器錯誤內容的明確錯誤訊息，且 SHALL NOT 產生空白逐字稿

### Requirement: 語者分離輸出格式一致性

當使用者啟用語者分離時，系統 SHALL 將伺服器回傳的語者分段轉換為與 AssemblyAI 路徑一致的 `[MM:SS 講者X] text` 格式。

#### Scenario: 啟用語者分離

- **WHEN** 使用者啟用語者分離且伺服器回傳含語者標籤的分段結果
- **THEN** 每一分段 SHALL 格式化為 `[MM:SS 講者X] 文字`，時間戳為該分段起始時間

#### Scenario: 未啟用語者分離

- **WHEN** 使用者未啟用語者分離
- **THEN** 系統 SHALL 回傳純逐字稿文字（可含時間戳），不含講者標籤

### Requirement: 繁體中文台灣用語輸出

系統 SHALL 確保本地伺服器供應商產出的逐字稿為繁體中文台灣用語。

#### Scenario: 中文語音輸入

- **WHEN** 輸入音訊為中文且供應商為 `voxnote_asr`
- **THEN** 輸出逐字稿 SHALL 為繁體中文（若模型輸出簡體則 SHALL 於服務端進行簡轉繁後處理）

### Requirement: 轉錄進度回報

系統 SHALL 在本地伺服器轉錄過程中透過既有 `asr_progress` 事件機制回報進度，與其他供應商行為一致。

#### Scenario: 轉錄進行中回報

- **WHEN** 本地伺服器轉錄正在進行
- **THEN** 系統 SHALL 依序發出「上傳音訊中」「轉錄中」「轉錄完成」等進度事件供前端顯示
