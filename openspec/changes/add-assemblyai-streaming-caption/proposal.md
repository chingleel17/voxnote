# Proposal

## Why

目前即時字幕依賴本地 Whisper 或自架服務的視窗式辨識，開發測試需要模型、推論環境及音訊切窗調校，難以快速驗證字幕與翻譯流程。新增 AssemblyAI 官方串流來源，讓開發者直接測試持續收音、暫定文字、完成段與翻譯更新，減少本地模型環境的干擾。

## What Changes

- 新增可選後端 `assemblyai_streaming`，以 Rust 連接 AssemblyAI Streaming v3 WebSocket，沿用現有麥克風與系統音訊擷取。
- 重用既有 AssemblyAI API Key，新增獨立的即時模型設定，預設 `universal-3-6-pro`；來源語言沿用即時字幕專屬設定，不改動批次模型或批次語言。
- 暫定結果覆寫同一字幕段；服務端完成段只送一次翻譯／校稿，沿用原文、譯文與雙語顯示選項。
- 串流路徑不套用 HTTP 音訊視窗、LocalAgreement 或文字相似度去重；選取此後端時隱藏不適用的模型檔、視窗及增量解碼設定。
- 定義有上限的音訊佇列、連線逾時、停止握手與錯誤回報；停止或關閉應用程式時終止服務端連線並清除本地字幕。
- 提供不需要金鑰或模型的模擬 WebSocket 測試，以及需明確啟用的實際串流驗收任務。
- 作為即時字幕第一個端到端開發與體驗驗收基準；共用 session 隔離、字幕歷史與停止正確性隨本變更交付，不等待本地增量效能調校。
- 所有後端共用依視窗容量呈現、具有資料上限的字幕歷史；4 秒段落輪替僅適用本地／自架增量，AssemblyAI 依服務端 turn 完成。

## Capabilities

### New Capabilities

- `assemblyai-streaming-caption`: 官方串流連線、音訊封包、服務端 turn 更新、完成段後處理及停止契約。

### Modified Capabilities

- `live-caption-overlay`: 納入新後端，區分 HTTP／本地增量／雲端串流路徑，補齊字幕更新識別與跨 session 隔離。
- `app-lifecycle-shutdown`: 主視窗關閉時在有限時間內終止串流連線與相關工作。

## Impact

- 後端：`src-tauri/src/live_caption/`、即時字幕 commands、設定與關閉流程；需透過 Cargo CLI 加入 TLS WebSocket client 所需相依套件。
- 前端：`src/pages/liveCaption.ts`、`src/api/liveCaption.ts`、`src/liveCaptionOverlay.ts`、`src/types/index.ts`。
- 重用現有收音與 LLM API；不新增資料庫 schema，不變更批次轉錄流程。
- 新 change 可獨立實作，不依賴 `add-live-caption-process-audio` 或 `add-streaming-incremental-caption` 未完成的任務。後者重疊的增量條文需一併限定適用後端，防止日後封存互相覆蓋。

本次僅建立規格與任務，未實作串流程式或啟用付費連線。

## Delivery Order

三份 change 維持獨立：先完成本變更的既有 mic/system 音源、串流、共用字幕契約及實測基準，再交付 `add-live-caption-process-audio`，最後完成 `add-streaming-incremental-caption` 剩餘本地／自架效能調校。共用 UI／停止正確性不得以效能調校延後為由略過；此順序不改變使用者預設後端，也不代表其他 change 已驗收。
