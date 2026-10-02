# Design

## Context

既有 `list_provider_models` 已支援六個 LLM 供應商。設定頁有使用者未提交的 datalist 與設定保存修正，實作須以目前工作樹為基礎。動機見 proposal.md。

## Goals / Non-Goals

**Goals:** 模型建議可更新且可手動輸入；自動語言請求符合 AssemblyAI 契約。

**Non-Goals:** 不下載模型權重、不自動改選使用者的 LLM、不修正既有錯誤逐字稿、不提供未經證實的 AssemblyAI 模型列表端點。

## Decisions

- 沿用模型清單 command 與既有原生 select 樣式，擴充共用下拉元件的 `filterable`、`allowCustom` 參數。篩選按鈕展開獨立搜尋欄位，搜尋字串不沿用已選模型；原生選單無法內嵌搜尋欄，因此維持原生選單並將篩選操作置於欄位旁。「手動輸入模型 ID」是明確選項，選取後才顯示輸入欄，避免 datalist 將已選值當成搜尋條件而隱藏其他模型。
- 每個設定頁區塊首次聚焦時載入一次，按鈕可再次載入；載入中不重複請求，成功才替換建議，錯誤保留原值並允許重試。
- 不把清單持久化；重開頁面即重新取得，避免過期資料。請求沿用既有保存目前設定的機制，保持未儲存 key/endpoint 的模型查詢可用。
- AssemblyAI auto/空語言明確傳 `language_detection=true`；明確語言只傳 `language_code`。
- 舊 `universal-3-pro` 在請求邊界正規化為 `universal-3-5-pro`。兩個官方已知模型以主模型加備援順序傳送；其他手動 ID 原樣作為單一主模型並保留 universal-2 備援，不猜測新模型能力。
- 模型清單支援官方已確認的分頁（Anthropic、Gemini），設定合理頁數上限，避免無窮請求。沒有公開清單 API 的 AssemblyAI 使用明確標示的內建建議與手動輸入。

## Risks / Trade-offs

- [模型列表端點不可用] → 保留模型值、內建建議與手動輸入，顯示錯誤。
- [API key 或 endpoint 改變後清單過期] → 使用者可重新整理，以當前設定查詢。
- [語言偵測仍可能錯判] → 中文會議可指定中文；本修正不保證模型品質。
- [模型被移除] → 不自動替換已保存的 LLM ID，由使用者選擇。

## Migration Plan

不新增資料庫欄位。舊 AssemblyAI 模型值在使用時轉換；其餘模型名稱維持。回復時可還原程式碼，設定格式不變。

## Sources

- https://www.assemblyai.com/docs/pre-recorded-audio/language-detection
- https://www.assemblyai.com/docs/pre-recorded-audio/select-the-speech-model
- https://platform.claude.com/docs/en/api/models/list
- https://ai.google.dev/api/models
