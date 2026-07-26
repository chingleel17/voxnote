## Purpose

定義本機與雲端 ASR 供應商進行語者分離時，如何從會議與會人員推導預期講者人數，以及淘汰全域人數設定的相容行為。

## Requirements

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
