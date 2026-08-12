## Context

`voxnote_asr` 服務端（`server/app.py`）目前 `POST /v1/audio/transcriptions` 為單發同步：客戶端上傳音訊後，HTTP 連線會一直等到轉錄、詞級對齊與（可選）語者分離全部完成才回傳。長會議處理可能達數分鐘，容易被 HTTP 逾時中斷，過程中也無法回報進度。

app 端呼叫雲端 AssemblyAI（`transcribe_assemblyai`）時，本就是「建立任務 → 輪詢狀態」的非同步模式。若 `voxnote_asr` 也改為非同步，app 端呼叫方式可與之收斂一致。

本 change 應於 `add-local-breeze-asr-service` 完成實機驗證後再實作，避免在未驗證的核心上疊加架構。

## Goals / Non-Goals

**Goals:**
- 轉錄端點改為非同步：立即回傳 `task_id`，背景執行。
- 提供任務狀態查詢與進度回報，支援長音訊。
- app 端改為建任務+輪詢，與 AssemblyAI 模式一致。
- 保持輕量，不增加維運負擔。

**Non-Goals:**
- 不引入外部資料庫或訊息佇列中介軟體（Redis、Celery 等）。
- 不做多 worker 平行轉錄（GPU 不宜並行，且單機情境無此需求）。
- 不做任務持久化（服務重啟後記憶體任務清空即可）。

## Decisions

### 決策 1：記憶體任務表 + FastAPI BackgroundTasks

以程序內的字典保存任務狀態（`task_id` → 狀態/進度/結果），搭配 FastAPI 內建 `BackgroundTasks` 或 asyncio 背景協程執行轉錄。單機服務足夠，零額外相依、零維運。

*替代方案*：Celery + Redis（TranscriptHub 類做法）——功能強但對單一 app 的服務過重，違反 YAGNI，不採用。

### 決策 2：循序處理，單一轉錄鎖

以 asyncio 鎖或單一背景工作確保同一時間至多一個轉錄執行。GPU 記憶體有限，並行轉錄易 OOM；排隊任務標記為 `queued`。

**此鎖的涵蓋範圍為單一 process。** 同一套程式碼會以不同 `ASR_MODEL` 部署多個實例（批次用 Breeze-ASR-26、即時字幕用適合英文的模型），各實例有各自的鎖，彼此不互斥。因此：

- 單一實例內的並行 OOM：本鎖可防。
- 跨實例的 GPU 記憶體與算力爭用：本鎖**無法**防，屬部署層面。長批次轉錄與即時字幕同時進行時，即時字幕的延遲會因 SM 爭用而惡化，此為使用者可接受的取捨（兩個 process 各自推進，仍優於單一 process 讓即時字幕排在整個批次工作之後）。

`_asr_model`（`server/app.py:147`）為單一欄位且無卸載路徑，故「單一實例動態切換模型」不可行——會退化為兩個模型同時常駐，VRAM 與雙實例相同卻多背共用鎖的缺點。此即採多實例而非參數化選模型的原因。

### 決策 3：進度粒度以階段為單位

轉錄流程分三階段（轉錄 → 對齊 → 語者分離），以階段完成度回報粗略進度（如 0/33/66/100），不追求逐秒精度。足以讓使用者知道進行到哪，實作簡單。

### 決策 4：app 端輪詢複用既有進度事件

`transcribe_voxnote_asr` 改為：POST 建任務取得 `task_id` → 定期 GET 任務狀態 → 透過既有 `asr_progress` 事件回報 → 完成後取結果。輪詢邏輯與 `transcribe_assemblyai` 對齊，降低維護成本。

## Risks / Trade-offs

- **服務重啟遺失進行中任務** → 單機情境可接受；app 端輪詢逾時後提示使用者重試，不做持久化。
- **記憶體任務表無限增長** → 完成的任務保留一段時間後清除（如完成後 1 小時），或以上限筆數淘汰最舊。
- **輪詢間隔取捨** → 間隔太短增加負載、太長延遲感知；沿用 AssemblyAI 既有的數秒級間隔。
- **背景例外未捕捉導致任務卡在 processing** → 背景執行以 try/except 包覆，例外時將任務標記為 `failed` 並記錄訊息。

## Migration Plan

1. 服務端新增任務表與 `GET /v1/tasks/{id}`，`POST` 改為背景執行並回傳 `task_id`。
2. app 端 `transcribe_voxnote_asr` 改為建任務+輪詢。
3. 以長音訊驗證：不逾時、進度正確回報、失敗路徑正確標記。

**Rollback**：服務端與 app 端同屬 `voxnote_asr` 路徑；回退至同步版本即可，不影響其他供應商。

## Open Questions

- 完成任務的保留時間與清除策略門檻（先以固定值，視實際使用調整）。
