## ADDED Requirements

### Requirement: Live captions use a source language independent of batch transcription

即時字幕 MUST 具備專屬的來源語言設定，與批次逐字稿流程所使用的來源語言設定各自獨立。變更其中一者 MUST NOT 影響另一者。

即時字幕的來源語言設定 MUST 可指定為自動偵測或明確語言。

#### Scenario: User transcribes Chinese meetings in batch but English video live

- **WHEN** 使用者將批次逐字稿的來源語言設為中文，並將即時字幕的來源語言設為英文
- **THEN** 批次逐字稿 MUST 以中文轉錄，且即時字幕 MUST 以英文轉錄，兩者互不覆寫

#### Scenario: User changes the batch transcription language

- **WHEN** 使用者變更批次逐字稿的來源語言
- **THEN** 即時字幕的來源語言 MUST 維持不變

#### Scenario: Live caption language is set to automatic detection

- **WHEN** 使用者將即時字幕來源語言設為自動偵測
- **THEN** 系統 MUST 交由轉錄後端自行判斷語言，且 MUST NOT 套用批次流程的語言設定

### Requirement: Live captions use a remote ASR endpoint independent of batch transcription

即時字幕使用遠端轉錄後端時，MUST 具備專屬的服務位址設定，與批次逐字稿所使用的自架 ASR 服務位址各自獨立，使兩者可指向載入不同模型的服務實例。

當即時字幕的遠端服務位址未設定或無法連線時，系統 MUST 於 session 啟動時回報可理解的錯誤原因，而非於 session 開始後才靜默失敗。

#### Scenario: Live caption and batch transcription point to different services

- **WHEN** 使用者將批次逐字稿指向載入繁中模型的服務實例，並將即時字幕指向載入英文低延遲模型的另一服務實例
- **THEN** 兩者 MUST 各自向所設定的位址發出請求，互不影響

#### Scenario: Live caption remote endpoint is unreachable at startup

- **WHEN** 使用者選擇遠端後端啟動即時字幕，但所設定的位址未填寫或無法連線
- **THEN** 系統 MUST 拒絕啟動 session，並回報指出該位址連線失敗的錯誤訊息

### Requirement: Remote live caption requests use timeouts suited to real-time cadence

即時字幕的遠端轉錄請求 MUST 使用適用於即時節奏的逾時上限，與批次長錄音所使用的逾時設定分離。單一視窗的請求逾時後，系統 MUST 放棄該視窗並繼續處理後續音訊，MUST NOT 中止 session，且 MUST NOT 重試該視窗。

系統 MUST 於同一 session 內重複使用既有的連線資源發出各視窗的請求，而非為每個視窗重新建立連線。

#### Scenario: A single remote request exceeds the real-time timeout

- **WHEN** 某個視窗的遠端轉錄請求超過即時逾時上限仍未回應
- **THEN** 系統 MUST 放棄該視窗、繼續處理後續音訊，且 MUST NOT 因此中止 session

#### Scenario: Batch transcription timeout is unaffected

- **WHEN** 即時字幕採用秒級逾時
- **THEN** 批次逐字稿的長錄音請求 MUST 維持其原有的逾時上限，不受即時設定影響

#### Scenario: Multiple windows are transcribed within one session

- **WHEN** 單一 session 內連續處理多個音訊視窗
- **THEN** 系統 MUST 重複使用同一組連線資源，MUST NOT 為每個視窗重建連線

### Requirement: System applies backpressure when transcription falls behind audio capture

當轉錄速度慢於音訊擷取速度時，系統 MUST 丟棄最舊的待處理音訊以保留最新音訊，使字幕跟隨當下播放的聲音。待處理音訊的累積量 MUST 有明確上限，MUST NOT 無限成長。

發生音訊丟棄時，系統 MUST 讓使用者能夠得知字幕內容有所遺漏，而非靜默略過。

#### Scenario: Transcription is slower than audio capture

- **WHEN** 轉錄後端處理速度持續慢於音訊擷取速度
- **THEN** 系統 MUST 丟棄最舊的待處理音訊，且後續字幕 MUST 對應當下播放的聲音而非逐漸落後的舊音訊

#### Scenario: Long session with sustained backlog

- **WHEN** session 長時間執行且轉錄持續落後
- **THEN** 待處理音訊佔用的記憶體 MUST 維持在上限之內

#### Scenario: User is informed of dropped audio

- **WHEN** 系統因背壓丟棄音訊
- **THEN** 系統 MUST 向使用者提示字幕有所遺漏

### Requirement: System deduplicates overlapping caption results by similarity

相鄰的轉錄視窗因重疊而可能對同一段語音產生內容相同但字面不完全一致的結果。系統 MUST 以相似度比對判定重複，MUST NOT 僅依賴前後綴的精確字串比對。

系統 MUST 對最近數筆已輸出的字幕結果進行比對，而非僅比對前一筆。

系統 MUST 避免對過短的文字誤判為重複。

#### Scenario: Same speech is recognized slightly differently across windows

- **WHEN** 相鄰視窗對同一段語音產生字面略有差異但內容相同的轉錄結果
- **THEN** 系統 MUST 判定為重複並且 MUST NOT 重複輸出該內容

#### Scenario: Duplicate content matches an earlier result rather than the immediately previous one

- **WHEN** 某段字幕與前數筆（非緊鄰前一筆）已輸出的字幕內容重複
- **THEN** 系統 MUST 判定為重複並且 MUST NOT 重複輸出

#### Scenario: Two short phrases differ only slightly but are genuinely different

- **WHEN** 兩段極短的文字字面相近但實為不同內容
- **THEN** 系統 MUST NOT 將其誤判為重複，兩者 MUST 皆被輸出

## MODIFIED Requirements

### Requirement: System skips the LLM call when translation would be a no-op

僅啟用翻譯（未啟用校稿）時，若使用者已明確指定來源語言且該語言與翻譯的目標語言相同，系統 MUST NOT 呼叫翻譯模型，MUST 直接顯示轉錄原文。此為節省延遲與費用的最佳化，翻譯開關本身的其餘行為不受影響。

即時字幕的翻譯目標語言 MUST 為繁體中文（台灣用語），為固定值而非使用者可設定項。本需求所稱「目標語言」即指此固定值；措辭上 MUST NOT 使人誤以為存在可設定的目標語言選項。

此最佳化 MUST 僅於來源語言為明確指定時適用。當來源語言設為自動偵測時，系統無法在呼叫轉錄後端之前得知實際語言，MUST NOT 嘗試判斷是否為同語言，MUST 依一般翻譯流程處理（不套用此最佳化）。

#### Scenario: Target language equals source language with only translation enabled

- **WHEN** 使用者啟用翻譯、未啟用校稿，且已明確指定來源語言為繁體中文（即等同固定的翻譯目標語言）
- **THEN** 系統 MUST 直接顯示轉錄原文，MUST NOT 對該段發出翻譯請求

#### Scenario: Target language equals source language with both enabled

- **WHEN** 使用者同時啟用翻譯與校稿，且已明確指定來源語言為繁體中文
- **THEN** 系統 MUST 執行校稿並顯示校正後的原語言字幕，此情境 MUST NOT 被本最佳化跳過（此時校稿本身即為使用者要的處理，見「Translation and proofreading are independent options」的同語言校稿情境）

#### Scenario: Source language is set to automatic detection

- **WHEN** 使用者將來源語言設為自動偵測，且啟用翻譯
- **THEN** 系統 MUST NOT 嘗試判斷偵測結果是否與目標語言相同，MUST 依一般翻譯流程處理該段字幕
