## Purpose

確保 AssemblyAI 轉錄時的自動語言與明確語言選項真正對應供應商請求契約，並讓舊模型設定在官方模型識別更新後仍可使用，避免設定畫面和實際轉錄請求的行為不一致。

## ADDED Requirements

### Requirement: 明確啟用自動語言偵測

當語言為 auto 或空值時系統 MUST 送出 `language_detection=true` 且 MUST NOT 送出 `language_code`；指定語言時 MUST 傳入對應 `language_code` 而不啟用自動偵測。

#### Scenario: 自動語言
- **WHEN** 使用者以自動語言轉錄
- **THEN** AssemblyAI 請求明確啟用語言偵測

#### Scenario: 中文語言
- **WHEN** 使用者指定中文
- **THEN** AssemblyAI 請求使用 language_code=zh 而不啟用自動偵測

### Requirement: 官方模型識別與舊設定相容

系統 MUST 支援 `universal-3-5-pro` 與 `universal-2`，並於發出請求時將舊 `universal-3-pro` 映射為 `universal-3-5-pro`。系統 MUST 保留使用者手動指定的其他模型識別。

#### Scenario: 舊設定升級
- **WHEN** 設定檔使用 universal-3-pro
- **THEN** 請求使用 universal-3-5-pro 並保留 universal-2 備援

#### Scenario: 自訂模型
- **WHEN** 使用者輸入另一個模型 ID
- **THEN** 該 ID 作為請求的優先模型，不被硬編碼條件忽略

### Requirement: ASR Chinese output uses Taiwan Traditional Chinese

AssemblyAI 與自架 ASR 的中文結果 MUST 在保存或顯示前透過共用 OpenCC s2twp 統一為台灣繁體。系統 MUST 保留時間戳、講者代號、英文、數字與標點；自架同步及增量字幕輸出 MUST 使用相同轉換。轉換初始化失敗 MUST 回報錯誤，不靜默當作已完成轉換。

#### Scenario: Simplified or mixed Chinese transcription
- **WHEN** 供應商回傳簡體或繁簡混合的逐字稿
- **THEN** 保存與顯示的中文使用台灣繁體與台灣詞彙

#### Scenario: Speaker segments and English content
- **WHEN** 回應包含講者分段、時間與英文內容
- **THEN** 僅中文文字被轉換，其他內容與分段順序保持不變
