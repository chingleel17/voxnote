## ADDED Requirements

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
