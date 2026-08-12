## Why

即時字幕已能運作，但實測情境與目前的預設假設不符，且效能路徑存在為批次流程設計而不適用於即時的實作。

**情境澄清**：本專案的會議錄音全為中文，走既有批次逐字稿流程；**即時字幕的實際用途是觀看英文影片**。兩者的來源語言相反。目前 `live_caption/mod.rs:462`、`:467` 兩個後端皆直接沿用 `config.asr_language`，而該欄位預設為 `zh`（`config/mod.rs:77`）且由批次流程共用——使用者為中文會議設定 `zh` 後，看英文影片的即時字幕會被迫以中文轉錄。即時字幕缺少屬於自己的來源語言設定。

**運算資源**：使用者具備一台 RTX 4090 主機，可作為即時字幕的推論後端。這與 jt-live-whisper 的 GPU server 模式概念相同，也與本專案既有的自架 ASR 服務（`voxnote_asr`）在**傳輸層**上相同（皆為 OpenAI 相容 multipart 端點）。但既有服務所載入的是 Breeze-ASR（繁中 fine-tune），**不適合轉錄英文**；且 `transcribe_voxnote_asr_bytes` 的連線參數是為長錄音批次設計的，直接沿用於 3 秒一次的即時節奏會造成明顯缺陷（見下）。

**模型分離的部署方式**：批次與即時所需的模型不同，但服務端為同一套 `server/app.py`（模型由 `ASR_MODEL` 環境變數決定）。部署上已採**單一對外埠 + gateway 路徑分流**：兩個 ASR 實例各自跑不同模型且皆不對外開埠，由 nginx 於同一埠依 `/batch/` 與 `/live/` 前綴轉發。此方式不占用額外對外埠，且兩實例仍為獨立 process、各有各的序列化鎖，故長會議轉錄不會使即時字幕排隊等待。詳見 `server/README.md` 的「雙實例部署」。

**重疊去重**：目前以 5 秒視窗／3 秒步進的重疊滑動窗切分，重疊處靠 `remove_overlap()` 做前後綴精確字串比對去重。滑動視窗重疊的本質是同一段語音被辨識兩次且結果未必逐字相同，前後綴精確比對在此情境下必然失效，導致重複字幕漏過。

經檢視 jt-live-whisper 實作後確認：其即時路徑同樣採重疊滑動視窗（線上會議 5000/3000 ms，與本專案現行參數同構），**並未**於即時路徑使用 VAD 切段——其 faster-whisper 即時參數明確設 `vad_filter=False`，VAD 僅用於台語模式與離線批次。其重疊去重採相似度比對（子字串重疊度 > 70% 與 `SequenceMatcher` > 0.6，對最近 10 筆比對）。故本變更改採相似度去重，不導入 VAD。

## What Changes

- **即時字幕獨立的來源語言設定**：新增專屬欄位，與批次流程的 `asr_language` 完全分離，使中文會議與英文影片可各自設定。
- **即時字幕獨立的遠端 ASR 端點設定**：新增專屬的服務位址與模型欄位，與批次流程所用的端點分離。搭配 gateway 部署時，兩者為同一主機同一埠的不同路徑前綴（批次 `/batch`、即時 `/live`），仍指向載入不同模型的獨立實例。
- **即時專用的遠端轉錄呼叫路徑**：不再沿用批次的 `transcribe_voxnote_asr_samples`，改以重用 HTTP client、秒級逾時、逾時即丟棄該視窗的即時路徑實作。
- **音訊佇列背壓**：轉錄落後時丟棄最舊音訊，確保字幕跟隨當下聲音而非逐漸落後，且佇列不無限成長。
- **相似度去重取代前後綴字串比對**：對最近數筆結果做相似度判定，解決重疊視窗辨識結果不逐字相同時的漏過。

**不在本變更範圍**：

- 視窗長度情境預設已於 2026-08-11 改移入 `add-live-caption-overlay` 的第 12 節（設定頁簡化的一部分），與該變更同時實作與驗收，不再由本變更提供。原因：使用者要求即時字幕頁的設定整理集中處理，情境預設與行數／字級簡化屬同一類「收起進階參數」工作，分兩個 change 做會讓實作與驗收脫節。
- 字幕視窗滑鼠穿透已隨 `add-live-caption-overlay` 歸檔完成（基準需求「System allows interacting with content beneath the caption window」），並實作為 session 級的鎖定切換而非持久化設定，故自本變更移除。

本變更不修改批次逐字稿、校稿、摘要或既有錄音流程的行為，無 breaking change。

## Capabilities

### New Capabilities
<!-- 無新增 capability。 -->

### Modified Capabilities
- `live-caption-overlay`: 新增來源語言與遠端後端的獨立設定、即時專用的遠端轉錄連線行為、音訊背壓策略與重疊結果的相似度去重。

## Dependency

`add-live-caption-overlay` 已於 2026-08-11 完成並歸檔（`openspec/changes/archive/2026-08-11-add-live-caption-overlay/`），`live-caption-overlay` 已進入 `openspec/specs/` 基準。本變更的 spec delta 維持以 `## ADDED Requirements` 撰寫，其所新增的需求皆為基準未涵蓋的行為。

與已歸檔變更的關係：

- 其任務 10.3（調校視窗長度、步進與靜音門檻預設值）已完成音訊主因（取樣率錯配）與幻覺過濾的調校，情境預設組合部分已於歸檔前併入該變更自身的第 12 節（見上方「不在本變更範圍」），不再與本變更重疊。
- 滑鼠穿透**已不在本變更範圍**：基準已含「System allows interacting with content beneath the caption window」（游標感應式穿透，標題列與邊框恢復互動），實作亦已依該需求完成為 session 級的「鎖定＝穿透」切換（不落盤，見 tasks 1.3、5.x）。本變更不再另立重複的穿透需求。

## Impact

**修改既有檔案**
- `src-tauri/src/config/mod.rs` 與 `src/types/index.ts`：新增即時字幕來源語言、遠端端點位址、遠端模型名稱、即時逾時秒數等欄位（已完成，見 tasks 1.x）。
- `src-tauri/src/asr/mod.rs`：新增即時專用的遠端轉錄函式（獨立的 client 重用與逾時策略），既有批次函式不變。
- `src-tauri/src/live_caption/mod.rs`：改以相似度去重、加入背壓、改用新的語言與端點設定。
- `src/components/liveCaptionSettings.ts`：新增對應設定項（即時字幕設定已於前一變更自 `settings.ts` 移至此檔）。

**外部相依**
- 無新增。相似度去重以標準函式庫實作即可，不需新的 crate。

**部署假設**
- RTX 4090 主機以 `docker compose` 同時啟動兩個 ASR 實例與一個 gateway：`asr-batch`（`ASR_MODEL`，Breeze-ASR-26）、`asr-live`（`ASR_LIVE_MODEL`，英文模型）、`gateway`（nginx，唯一對外埠）。兩個 ASR 實例為**同一套 `server/app.py`**，僅環境變數不同（`server/app.py:154-158` 顯示模型由 `ASR_MODEL` 決定）。此屬環境準備，已於 `server/docker-compose.yml` 與 `server/nginx.conf` 完成，不在本變更的程式碼範圍內。

- **客戶端無須為此調整程式碼**：`transcribe_voxnote_asr_bytes`（`asr/mod.rs:261`）與健康檢查（`live_caption_cmds.rs:82`、`settings_cmds.rs:54`）皆以 `base_url` 去尾斜線後直接串接路徑，故 base URL 填入含前綴的位址（如 `http://host:8000/live`）即可正確組出端點。設定值的差異純屬部署設定，非程式邏輯。

- **模型選擇**：Breeze-ASR-26 是針對台灣中文與中英混用的 fine-tune，**不適合英文影片**；同尺寸下其速度與原版 Whisper 相當（皆為 Whisper 架構、皆走 CTranslate2），故換 Breeze 為 Whisper 不會變快。若需降低即時延遲，應調整**模型尺寸**與 `compute_type`，而非更換 fine-tune。

  即時實例預設採 `distil-large-v3`（英文蒸餾版，速度約 large-v3 的 6 倍而品質接近），為 WhisperX 內建代號，首次載入時自動下載，無須如 Breeze 般自行轉為 CTranslate2 格式。此模型為英文專用，若即時字幕需轉錄其他語言應改用 `large-v3`。詳見 `server/README.md` 的「即時字幕的模型選擇」。

- **與 `add-async-transcription-queue` 的契約相依**：因兩個實例為同一套程式碼，該變更的非同步化會一併影響即時字幕所用的端點。該變更已據此保留由呼叫方指定的**同步模式**（見其 spec 的「即時呼叫方保留同步轉錄模式」）。本變更第 2 節的即時轉錄路徑 MUST 使用該同步模式，故**應於該變更完成後再實作第 2 節**，避免依據即將改變的契約撰寫程式碼。
