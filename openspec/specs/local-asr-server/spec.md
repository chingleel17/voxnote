## Purpose

定義本地 ASR 伺服器供應商 `voxnote_asr` 的基礎轉錄能力（OpenAI 相容端點、語者分離輸出格式、繁體中文輸出、進度回報），以及本機與雲端 ASR 供應商進行語者分離時，如何使用每段錄音的獨立發言人數或自動判斷，並維持舊資料與全域設定淘汰的相容行為。

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

服務端 MUST 於轉錄回應中標示該次語者分離是否在詞級對齊完成的前提下產生。詞級對齊失敗時，服務 MUST 仍以未對齊結果完成轉錄且 MUST NOT 中斷流程，但 MUST 將該狀態標示於回應中，MUST NOT 僅記錄於伺服器 log。

此標示 MUST 為選填欄位並具預設值，使未提供該欄位的舊版服務端不致造成客戶端解析失敗。同步與非同步兩種模式的回應 MUST 同樣包含此標示。降級 MUST NOT 改變上述輸出格式。

#### Scenario: 啟用語者分離

- **WHEN** 使用者啟用語者分離且伺服器回傳含語者標籤的分段結果
- **THEN** 每一分段 SHALL 格式化為 `[MM:SS 講者X] 文字`，時間戳為該分段起始時間

#### Scenario: 未啟用語者分離

- **WHEN** 使用者未啟用語者分離
- **THEN** 系統 SHALL 回傳純逐字稿文字（可含時間戳），不含講者標籤
- **AND** 降級標示不具意義、不影響客戶端行為

#### Scenario: 詞級對齊失敗但啟用語者分離

- **WHEN** 詞級強制對齊拋出例外，而請求已啟用語者分離
- **THEN** 服務以未對齊結果繼續完成轉錄並回傳講者代號
- **AND** 回應標示該次語者分離已降級

#### Scenario: 非同步任務結果保留降級標示

- **WHEN** 客戶端輪詢非同步任務並取得完成結果
- **THEN** 任務結果包含與同步模式相同的降級標示

### Requirement: 語者分離降級狀態隨錄音段落保存

轉錄為非同步流程，使用者未必於完成當下檢視結果。Rust app MUST 將服務端回傳的語者分離降級狀態隨該錄音段落一併保存，MUST NOT 僅於轉錄完成當下傳遞。

資料庫欄位新增 MUST 以 `ALTER TABLE` 向下相容方式進行，MUST NOT 刪除或變更既有欄位。

#### Scenario: 轉錄完成並保存降級狀態

- **WHEN** 本地 ASR 服務回傳已降級的語者分離結果
- **THEN** 該錄音段落保存降級狀態，使用者稍後開啟會議時仍可取得

#### Scenario: 服務端未提供降級標示

- **WHEN** 舊版服務端回應不含降級標示欄位
- **THEN** 客戶端視為未降級，行為與本變更前一致

### Requirement: 語者分離可信度提示

使用者確認講者標籤的位置為會議頁的錄音段落與講者對應區。語者分離降級時，UI MUST 於這些位置顯示明確提示，指引使用者優先確認該段落的講者標籤。

提示 MUST 表達為品質標示而非錯誤，MUST NOT 暗示轉錄文字不可用——降級僅影響講者標籤可靠度，逐字稿文字本身仍為有效結果。

未啟用語者分離的錄音段落 MUST NOT 顯示任何相關提示。

#### Scenario: 降級段落於會議頁呈現

- **WHEN** 使用者開啟含有已降級錄音段落的會議
- **THEN** 該段落與講者對應區顯示可信度提示，指引優先確認講者標籤

#### Scenario: 未降級段落不顯示提示

- **WHEN** 錄音段落的語者分離在詞級對齊完成下產生
- **THEN** 不顯示任何可信度提示

#### Scenario: 未啟用語者分離的段落

- **WHEN** 錄音段落轉錄時未啟用語者分離
- **THEN** 不顯示任何語者分離相關提示

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

### Requirement: 預期講者人數由錄音段落獨立設定
每段錄音 MUST 提供「本段發言人數」，可選自動判斷或指定 1 至 20 人，並獨立儲存。此範圍為應用程式目前提供的選項，不代表所有供應商的最大支援人數。預設及舊錄音 MUST 採自動判斷，MUST NOT 從整場與會名單推算精確人數。設定變更於下一次轉譯套用，不自動改寫已有逐字稿。

#### Scenario: 上下段發言人數不同
- **WHEN** 同場會議名單有 8 人，上半段指定 8 人，下半段指定 3 人
- **THEN** 系統 MUST 將各段設定分別傳給供應商，MUST NOT 把下半段人數改成 8

#### Scenario: 本段採自動判斷
- **WHEN** 本段未指定人數或使用者改回自動
- **THEN** 系統 MUST 不帶入人數參數，不論整場會議名單有多少人

#### Scenario: 設定無效或錄音不存在
- **WHEN** 人數不在 1 至 20 範圍且不是自動，或找不到指定錄音
- **THEN** 系統 MUST 拒絕儲存並顯示原因，不覆寫原值

#### Scenario: 匯入舊備份
- **WHEN** 舊備份的錄音沒有 speaker_count 欄位
- **THEN** 覆蓋與合併匯入 MUST 都成功，該錄音人數預設自動；新備份 MUST 保留逐段設定

#### Scenario: 未啟用語者分離
- **WHEN** 使用者未啟用語者分離
- **THEN** 系統 MUST NOT 帶入預期講者人數參數

### Requirement: AssemblyAI 帶入預期講者人數
使用 AssemblyAI 供應商且啟用語者分離時，只有本段已明確指定人數才 MUST 帶入 `speakers_expected`，未指定 MUST 省略。

#### Scenario: 人數在有效範圍內
- **WHEN** 本段明確指定人數介於 1 至 20 且啟用語者分離
- **THEN** 系統 MUST 於 AssemblyAI 請求 body 帶入 `speakers_expected`

#### Scenario: 自動判斷
- **WHEN** 本段選擇自動判斷
- **THEN** 系統 MUST NOT 帶入 `speakers_expected`，改由 AssemblyAI 自動判斷

### Requirement: 自架服務帶入預期講者人數
使用 `voxnote_asr` 供應商且啟用語者分離時，系統 MUST 以本段明確指定的人數同時設定 `min_speakers` 與 `max_speakers`；自動時 MUST 省略兩者，不使用整場與會人數。

#### Scenario: 已知人數
- **WHEN** 本段明確指定人數且啟用語者分離
- **THEN** 系統 MUST 將 `min_speakers` 與 `max_speakers` 皆設為該人數

#### Scenario: 未指定或未啟用分離
- **WHEN** 本段採自動或未啟用語者分離
- **THEN** 系統 MUST 不傳 min_speakers 與 max_speakers

### Requirement: 全域預期講者人數設定已移除
系統 MUST NOT 提供設定頁的預期講者人數欄位或使用 `local_asr_speaker_hint` 設定。舊有 config.toml 中殘留的 `local_asr_speaker_hint` MUST 被忽略，且不得阻礙設定載入或轉錄。

#### Scenario: 使用者檢視設定頁
- **WHEN** 使用者開啟設定頁
- **THEN** 系統 MUST NOT 顯示可指定預期講者人數的欄位

#### Scenario: 設定檔含有已淘汰的設定鍵
- **WHEN** 系統載入含有 `local_asr_speaker_hint` 的既有 config.toml
- **THEN** 系統 MUST 忽略該設定鍵並正常載入設定

### Requirement: 語者分離依字級標籤切分分段

Whisper 的 segment 切點依語音停頓與句子完整度決定，與講者輪替點不重合，單一 segment 可能橫跨講者變更處。`assign_word_speakers` 已產生字級講者標籤，服務端 MUST 據此切分，MUST NOT 僅取 segment 層級的講者標籤。

同一 segment 內相鄰字的講者標籤不同時，服務端 MUST 於該處切分為獨立分段。切分後各分段的時間戳 MUST 取自該分段所涵蓋字級區間的實際起訖時間，MUST NOT 沿用原 segment 的時間戳。

切分規則 MUST 為決定性比較，MUST NOT 引入機率判斷或模型推論；相同輸入 MUST 產生相同輸出。

切分後的分段 MUST 維持既有的講者代號正規化規則與 `[MM:SS 講者X]` 輸出格式，MUST NOT 改變輸出格式。

#### Scenario: 單一 segment 橫跨講者變更

- **WHEN** 某 segment 內的字級標籤顯示前半屬講者 A、後半屬講者 B
- **THEN** 該 segment 切分為兩個分段，各自標註對應講者
- **AND** 兩分段的時間戳分別取自其涵蓋的字級區間

#### Scenario: segment 內講者一致

- **WHEN** 某 segment 內所有字的講者標籤相同
- **THEN** 不切分，輸出單一分段

#### Scenario: 未啟用語者分離

- **WHEN** 轉錄請求未啟用語者分離
- **THEN** 不執行字級切分，分段維持既有行為且不含講者標籤

### Requirement: 字級標籤缺漏時沿用前一字標籤

`assign_word_speakers` 已知會間歇性遺漏部分字的講者標籤，且不可穩定重現。

服務端 MUST NOT 直接存取字級講者標籤而未處理缺漏。標籤缺漏時 MUST 沿用前一字的標籤，MUST NOT 視為講者變更——缺值代表資訊未知而非身分改變，視為變更會產生大量錯誤切點。

段落開頭即缺漏標籤時 MUST 安全處理，MUST NOT 中斷轉錄。

#### Scenario: 中段字級標籤缺漏

- **WHEN** segment 中某字缺少講者標籤，其前後字標籤相同
- **THEN** 該字沿用前一字標籤，不產生切點

#### Scenario: 段落開頭標籤缺漏

- **WHEN** segment 首字即缺少講者標籤
- **THEN** 服務完成轉錄且不中斷，該分段依既有規則決定講者標籤

### Requirement: 分群門檻可設定

pyannote 以 AHC 分群決定講者身分。同一人在音量、語氣、麥克風距離變化或長時間間隔後再發言時，embedding 距離可能超過分群門檻而未被合併，導致一人被判為多個講者。

服務端 MUST 提供分群門檻的設定途徑，MUST NOT 僅採模型預設值而無法調整。未設定時 MUST 採模型預設值，行為與本變更前一致。

WhisperX 的 pipeline 包裝不暴露分群超參數，門檻位於底層 pyannote pipeline。取用該內部結構失敗時，服務 MUST 安全降級為模型預設值並記錄 log，MUST NOT 中斷轉錄。

#### Scenario: 設定分群門檻

- **WHEN** 服務端設定了分群門檻值
- **THEN** 語者分離以該門檻執行分群

#### Scenario: 未設定分群門檻

- **WHEN** 服務端未設定分群門檻
- **THEN** 採模型預設值，行為與本變更前一致

#### Scenario: 內部結構取用失敗

- **WHEN** 因 WhisperX 版本變動導致無法取用底層 pipeline 參數
- **THEN** 服務以模型預設值完成轉錄並記錄 log，不中斷流程

### Requirement: 覆寫分群參數時保留其餘參數

pyannote 的參數實例化需要完整參數字典。僅傳入目標鍵會使其餘既有參數遺失，造成非預期的分離行為。

服務端 MUST 先取得完整的既有參數，覆寫目標鍵後整份傳回，MUST NOT 僅傳入部分參數。

#### Scenario: 覆寫門檻

- **WHEN** 服務端覆寫分群門檻
- **THEN** 其餘既有參數維持原值，未因覆寫而遺失

### Requirement: 轉錄回應提供講者嵌入向量

pyannote 於語者分離過程中已計算每位講者的嵌入向量，目前於轉錄完成後即丟棄。啟用語者分離時，服務端 MUST 於回應附上每位講者的嵌入向量，以及產生該向量的 diarization 模型識別。

向量 MUST 以正規化後的講者代號為鍵，與分段中的講者標籤一致，使客戶端能將向量對應到逐字稿中的講者。

服務端 MUST NOT 保存或比對向量——聲紋庫繫結客戶端的本地參與者資料，服務端維持無狀態。

向量欄位 MUST 為選填，使既有客戶端在服務端更新後不致解析失敗；同步與非同步兩種模式 MUST 同樣提供。

#### Scenario: 啟用語者分離並取得向量

- **WHEN** 客戶端以 `diarize=true` 發出轉錄請求
- **THEN** 回應包含每位講者的嵌入向量與模型識別
- **AND** 向量的鍵與分段中的講者代號一致

#### Scenario: 未啟用語者分離

- **WHEN** 客戶端以 `diarize=false` 發出轉錄請求
- **THEN** 回應不含嵌入向量欄位

#### Scenario: 非同步任務結果包含向量

- **WHEN** 客戶端輪詢非同步任務並取得完成結果
- **THEN** 任務結果包含與同步模式相同的向量與模型識別

#### Scenario: 向量無法取得時不中斷轉錄

- **WHEN** 語者分離完成但嵌入向量無法取得
- **THEN** 服務仍回傳完整轉錄與講者代號，向量欄位從缺
- **AND** 客戶端照常處理轉錄結果，僅不提供聲紋比對
