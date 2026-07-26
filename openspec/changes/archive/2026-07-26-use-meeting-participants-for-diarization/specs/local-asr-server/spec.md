## ADDED Requirements

### Requirement: 預期講者人數取自會議與會人員

啟用語者分離時，系統 SHALL 以該場會議的與會人員數作為預期講者人數傳給轉錄供應商，以提升語者分離準確度。系統 SHALL NOT 要求使用者於設定頁另行指定人數。

#### Scenario: 會議有與會人員

- **WHEN** 轉錄一場已登錄 N 位與會人員的會議且啟用語者分離
- **THEN** 系統 SHALL 將 N 作為預期講者人數傳給所選供應商

#### Scenario: 會議無與會人員或查詢失敗

- **WHEN** 會議未登錄任何與會人員，或查詢會議資料失敗
- **THEN** 系統 SHALL 以「未知」處理（不帶入人數參數），交由供應商自動偵測，且 SHALL NOT 中斷轉錄

#### Scenario: 未啟用語者分離

- **WHEN** 使用者未啟用語者分離
- **THEN** 系統 SHALL NOT 帶入預期講者人數參數

### Requirement: AssemblyAI 帶入預期講者人數

使用 AssemblyAI 供應商且啟用語者分離時，系統 SHALL 於請求中帶入 `speakers_expected` 參數。

#### Scenario: 人數在有效範圍內

- **WHEN** 與會人員數介於 1 至 20
- **THEN** 系統 SHALL 於 AssemblyAI 請求 body 帶入 `speakers_expected`

#### Scenario: 人數超出有效範圍

- **WHEN** 與會人員數為 0 或超過 20（AssemblyAI 支援上限）
- **THEN** 系統 SHALL NOT 帶入 `speakers_expected`，改由 AssemblyAI 自動判斷

### Requirement: 自架服務帶入預期講者人數

使用 `voxnote_asr` 供應商且啟用語者分離時，系統 SHALL 以與會人員數同時設定 `min_speakers` 與 `max_speakers`，鎖定 pyannote 的分離人數。

#### Scenario: 已知人數

- **WHEN** 與會人員數大於 0
- **THEN** 系統 SHALL 將 `min_speakers` 與 `max_speakers` 皆設為該人數

## REMOVED Requirements

### Requirement: 設定頁指定預期講者人數

**Reason**: 人數屬於個別會議的屬性，全域設定值無法反映各場會議差異；建立會議時已登錄與會人員，可直接推導人數，設定頁欄位為多餘的重複輸入。

**Migration**: 移除設定頁「預期人數」欄位與 `local_asr_speaker_hint` 設定鍵；人數改由會議的與會人員數自動取得，使用者無需操作。舊 config.toml 中的殘留鍵會被忽略，無需手動處理。
