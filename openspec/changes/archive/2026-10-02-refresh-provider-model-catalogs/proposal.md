# Proposal

## Why

AssemblyAI 的自動語言選項未明確啟用語言偵測，可能產生錯誤語言的原始逐字稿；模型識別也已落後官方文件。LLM 已有清單 API，但載入與更新操作不一致，使用者無法可靠取得新模型。

## What Changes

- 修正 AssemblyAI 自動語言請求，更新模型識別並相容舊設定。
- 為各 LLM 供應商提供可輸入模型名稱的建議清單、首次開啟自動載入及手動重新整理。
- 每次開啟設定頁重新建立載入狀態；失敗保留已選模型與既有建議，不阻擋手動輸入。
- AssemblyAI 沒有已確認的公開模型清單 API，提供官方模型備援與手動輸入，不宣稱可遠端更新清單。

## Capabilities

### New Capabilities
- `provider-model-catalog`: 供應商模型建議清單、載入、重新整理與手動指定。
- `assemblyai-language-selection`: AssemblyAI 明確語言與自動語言請求，以及模型識別相容。

### Modified Capabilities
無。

## Impact

影響設定頁、AssemblyAI 請求建構與既有模型清單 command。沿用 Vanilla TypeScript、Tauri invoke wrapper 和既有 HTTP client，不新增套件或資料庫欄位。保留設定頁現有未提交修改。
