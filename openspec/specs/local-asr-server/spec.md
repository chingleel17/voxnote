## Purpose

定義本地 ASR 伺服器供應商 `voxnote_asr` 的基礎轉錄能力（OpenAI 相容端點、語者分離輸出格式、繁體中文輸出、進度回報），以及本機與雲端 ASR 供應商進行語者分離時，如何從會議與會人員推導預期講者人數，並淘汰全域人數設定的相容行為。

## Requirements

### Requirement: 本地 ASR 伺服器供應商選項

系統 SHALL 提供第三個 ASR 供應商 `voxnote_asr`，與既有的 `assemblyai` 及本地 Whisper CLI（既有字串為 `local`）並列，讓使用者可將轉錄工作導向自架的 OpenAI 相容 ASR 服務。新供應商字串 SHALL NOT 與既有的 `assemblyai`、`local` 衝突。

#### Scenario: 使用者選擇本地伺服器供應商

- **WHEN** 使用者在設定頁將 ASR 供應商設為「本地伺服器」並填入有效的 Base URL
- **THEN** 系統 SHALL 將該設定持久化，且後續轉錄請求 SHALL 送往該伺服器而非 AssemblyAI 或本地 Whisper CLI

#### Scenario: 未設定 Base URL 時的防護

- **WHEN** 供應商為 `voxnote_asr` 但 Base URL 為空
- **THEN** 系統 SHALL 回傳明確錯誤訊息「本地 ASR 伺服器位址未設定」，且 SHALL NOT 送出請求

### Requirement: 透過 OpenAI 相容端點進行轉錄

系統 SHALL 以 HTTP multipart 上傳音訊檔至伺服器的 `/v1/audio/transcriptions` 端點。該端點預設採非同步任務模式：立即回傳 `task_id`，客戶端 SHALL 透過任務狀態查詢端點取得最終逐字稿結果。

該端點 SHALL 同時保留同步回應模式供即時呼叫方使用（見「即時呼叫方保留同步轉錄模式」）。

#### Scenario: 成功建立轉錄任務

- **WHEN** 音訊檔成功上傳且未要求同步回應
- **THEN** 系統 SHALL 立即回傳 `task_id`，並於背景執行轉錄；客戶端 SHALL 輪詢任務狀態直至完成後取得逐字稿

#### Scenario: 成功轉錄

- **WHEN** 客戶端輪詢任務狀態且該任務已完成
- **THEN** 系統 SHALL 回傳完整逐字稿內容供呼叫端使用

#### Scenario: 伺服器不可達或回傳錯誤

- **WHEN** 伺服器連線失敗、逾時或回傳非成功狀態碼
- **THEN** 系統 SHALL 回傳含伺服器錯誤內容的明確錯誤訊息，且 SHALL NOT 產生空白逐字稿

### Requirement: 即時呼叫方保留同步轉錄模式

轉錄端點 MUST 提供由呼叫方於請求中指定 `sync=true` 的同步回應模式，使呼叫方能於單一請求內取得逐字稿而無須建立任務並輪詢。

同步模式 MUST 由呼叫方於請求中明確指定 `sync=true`，MUST NOT 依伺服器端設定決定，使同一服務實例可同時服務批次與即時兩種呼叫方。

同步模式下的轉錄 MUST 與非同步模式共用相同的轉錄邏輯與輸出格式，MUST NOT 各自維護可能分歧的實作。

#### Scenario: 即時字幕以同步模式呼叫

- **WHEN** 即時字幕對某個數秒長度的音訊視窗發出轉錄請求並指定同步模式
- **THEN** 系統 MUST 於該次請求的回應中直接回傳逐字稿，MUST NOT 要求呼叫方另行輪詢

#### Scenario: 批次流程以非同步模式呼叫同一服務

- **WHEN** 批次逐字稿對同一服務實例發出轉錄請求且未指定同步模式
- **THEN** 系統 MUST 以任務模式回應，回傳 `task_id` 供輪詢

#### Scenario: 兩種模式的輸出格式一致

- **WHEN** 相同音訊分別以同步與非同步模式轉錄
- **THEN** 兩者所得的逐字稿內容與分段格式 MUST 一致

### Requirement: Rust app 使用非同步任務流程

Rust app 使用 `voxnote_asr` 進行一般轉錄時 SHALL 先建立非同步任務，再輪詢 `GET /v1/tasks/{task_id}` 直到任務完成或失敗，並透過既有 `asr_progress` 事件回報服務端進度。

#### Scenario: 建立任務後輪詢

- **WHEN** Rust app 將音訊送至 `/v1/audio/transcriptions` 且未指定 `sync=true`
- **THEN** Rust app SHALL 取得 `task_id`，持續輪詢對應任務狀態，並於 `done` 時取得逐字稿結果

#### Scenario: 任務失敗或輪詢不可用

- **WHEN** 任務狀態為 `failed`，或輪詢期間服務端不可達、逾時
- **THEN** Rust app SHALL 回傳明確錯誤或降級提示，且 SHALL NOT 產生空白逐字稿

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

### Requirement: 預期講者人數取自會議與會人員
啟用語者分離時，系統 MUST 以該場會議的與會人員數作為預期講者人數傳給轉錄供應商，以提升語者分離準確度。系統 MUST NOT 要求使用者於設定頁另行指定人數。

#### Scenario: 會議有與會人員
- **WHEN** 轉錄一場已登錄 N 位與會人員的會議且啟用語者分離
- **THEN** 系統 MUST 將 N 作為預期講者人數傳給所選供應商

#### Scenario: 會議無與會人員或查詢失敗
- **WHEN** 會議未登錄任何與會人員，或查詢會議資料失敗
- **THEN** 系統 MUST 以未知處理，不帶入人數參數，交由供應商自動偵測，且不得中斷轉錄

#### Scenario: 未啟用語者分離
- **WHEN** 使用者未啟用語者分離
- **THEN** 系統 MUST NOT 帶入預期講者人數參數

### Requirement: AssemblyAI 帶入預期講者人數
使用 AssemblyAI 供應商且啟用語者分離時，系統 MUST 於請求中帶入 `speakers_expected` 參數。

#### Scenario: 人數在有效範圍內
- **WHEN** 與會人員數介於 1 至 20
- **THEN** 系統 MUST 於 AssemblyAI 請求 body 帶入 `speakers_expected`

#### Scenario: 人數超出有效範圍
- **WHEN** 與會人員數為 0 或超過 20
- **THEN** 系統 MUST NOT 帶入 `speakers_expected`，改由 AssemblyAI 自動判斷

### Requirement: 自架服務帶入預期講者人數
使用 `voxnote_asr` 供應商且啟用語者分離時，系統 MUST 以與會人員數同時設定 `min_speakers` 與 `max_speakers`，鎖定 pyannote 的分離人數。

#### Scenario: 已知人數
- **WHEN** 與會人員數大於 0
- **THEN** 系統 MUST 將 `min_speakers` 與 `max_speakers` 皆設為該人數

### Requirement: 全域預期講者人數設定已移除
系統 MUST NOT 提供設定頁的預期講者人數欄位或使用 `local_asr_speaker_hint` 設定。舊有 config.toml 中殘留的 `local_asr_speaker_hint` MUST 被忽略，且不得阻礙設定載入或轉錄。

#### Scenario: 使用者檢視設定頁
- **WHEN** 使用者開啟設定頁
- **THEN** 系統 MUST NOT 顯示可指定預期講者人數的欄位

#### Scenario: 設定檔含有已淘汰的設定鍵
- **WHEN** 系統載入含有 `local_asr_speaker_hint` 的既有 config.toml
- **THEN** 系統 MUST 忽略該設定鍵並正常載入設定
