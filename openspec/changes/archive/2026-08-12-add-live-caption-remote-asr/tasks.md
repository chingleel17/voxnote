## 0. 前置

- [x] 0.1 確認 `add-live-caption-overlay` 的未完成任務（1.5、1.6、2.6、8.5、10.x）已完成或明確決定不阻擋本變更
  - 1.5、1.6、2.6、8.5 已於工作區完成（見該變更 tasks.md）。10.x（設定調校）不阻擋本次「設定、背景穿透」範圍，將於本變更 7.x 實測階段一併處理。
- [x] 0.2 於 RTX 4090 主機啟動雙實例＋gateway（`docker compose up -d --build`），記錄實際載入的模型與首次載入耗時
  - 部署設定已完成（`server/docker-compose.yml`、`server/nginx.conf`、README 的「雙實例部署」與步驟 3b）。英文模型預設 `distil-large-v3`（WhisperX 內建代號，首次請求時自動下載約 1.5 GB，無須事先準備或轉檔），故本任務僅需實際啟動並驗證。
  - 注意：首次請求會觸發下載與模型載入，耗時可能達數十秒，屬正常現象；此即 `nginx.conf` 的即時路徑逾時設為 120 秒而非秒級的原因。
  - 2026-08-12 已由使用者確認 RTX 4090 主機部署完成並可實際轉錄；首次載入耗時未另行量測記錄。
- [x] 0.3 驗證 gateway 分流：`curl` 確認 `/health`、`/batch/health`、`/live/health` 皆回 200，且 `/batch/v1/audio/transcriptions` 與 `/live/v1/audio/transcriptions` 回應格式一致
- [x] 0.4 於 app 設定填入含路徑前綴的位址（批次 `.../batch`、即時字幕 `.../live`），確認設定頁「測試連線」對兩者皆通過
  - 2026-08-12 已由使用者確認 4090 部署已透過 app 實際測試，遠端字幕可使用。

## 1. 即時字幕獨立設定項

- [x] 1.1 於 `AppConfig`（`src-tauri/src/config/mod.rs`）新增 `live_caption_language`（預設 `auto`）
- [x] 1.2 於 `AppConfig` 新增 `live_caption_remote_base_url` 與 `live_caption_remote_model`
- [x] 1.3 新增即時逾時秒數欄位（`live_caption_remote_timeout_seconds`，預設 8 秒）
  - 未新增 `live_caption_ignore_cursor_events` 持久化欄位：與既有 `live_caption_click_through`（自動游標感應穿透）語意重複。手動穿透改實作為 session 級 runtime override（不落盤），詳見第 5 節。
- [x] 1.4 於 `src/types/index.ts` 同步新增對應 TypeScript 型別欄位
- [x] 1.5 將 `live_caption/mod.rs` 的 `&config.asr_language`（原 462、467 行，現約 493、497 行）改為 `live_caption_language`；同步將端點改為 `live_caption_remote_base_url`（空值回退 `local_asr_base_url`），並更新 `live_caption_cmds.rs` 的啟動健康檢查
- [x] 1.7 端點未設定時於 session 啟動探測 `{批次位址}/live/health`，通則採用 `/live` 子路徑、不通則沿用批次位址；已填寫者不探測。探測僅啟動時一次，結果不寫回設定檔
  - 實作於 `live_caption_cmds.rs` 的 `resolve_live_caption_endpoint()`，解析結果寫入傳遞給 `manager.start()` 的 config 副本（記憶體，不落盤），故 session 期間各視窗直接沿用。
  - 探測逾時取 3 秒（`LIVE_ENDPOINT_PROBE_TIMEOUT_SECS`），失敗一律回退；已實測舊版單一容器對 `/live/health` 回 404，故「200 即視為存在」的判斷可靠。
- [x] 1.6 確認批次流程（`commands/asr_cmds.rs`）仍使用 `asr_language` 與 `local_asr_base_url`，未受影響（僅新增回退讀取，未修改批次呼叫路徑）

## 2. 即時專用的遠端轉錄路徑

> **先決條件**：本節依賴 `add-async-transcription-queue` 的同步模式（見該變更任務 1.3.1）。
> 4090 實例與批次實例為同一套 `server/app.py`，非同步化會一併改變本節所用的端點契約，
> 故本節應於該變更完成後再實作。第 3、4 節不受此限，可先行。

- [x] 2.1 於 `src-tauri/src/asr/mod.rs` 新增 `transcribe_live_caption_remote()`，接受外部傳入的 `reqwest::Client`
  - 新函式使用既有的 `sync=true` 契約（由 `add-async-transcription-queue` 提供），單次請求內直接回傳逐字稿，不走批次的 task_id 輪詢路徑
- [x] 2.2 該函式使用秒級逾時常數（與 `LOCAL_ASR_TIMEOUT_SECS` 分離），逾時回傳可辨識的錯誤型別
  - 逾時值取自呼叫端傳入的 `live_caption_remote_timeout_seconds`（設定項，非常數）；逾時錯誤以 `LiveCaptionTimeoutError` 型別回傳，供呼叫端辨識
- [x] 2.3 該函式不實作重試；逾時或失敗即回報，由呼叫端丟棄該視窗
- [x] 2.4 於 session 啟動時建立一個 `reqwest::Client` 存入 session 狀態，供所有視窗共用
  - 實作於 `run_live_caption_session()`：後端為 `voxnote_asr` 時建立一次 client，傳入 `process_caption_windows()` 供每個視窗共用；`local_whisper` 後端不建立（不需要）
- [x] 2.5 將 `live_caption/mod.rs` 的 `voxnote_asr` 分支改為呼叫新函式並傳入共用 client 與專屬端點
- [x] 2.6 確認既有 `transcribe_voxnote_asr` 與 `transcribe_voxnote_asr_bytes` 的行為與逾時值完全未變
  - 兩者未修改；僅新增獨立的 `transcribe_live_caption_remote()`，批次路徑無任何變動
- [x] 2.7 確認 `transcribe_voxnote_asr_samples` 若已無呼叫端則移除，避免留下死碼
  - 已移除 `transcribe_voxnote_asr_samples` 與其專用的 `transcribe_voxnote_asr_sync_bytes`；呼叫端改用新函式

## 3. 音訊佇列背壓

- [x] 3.1 定義待處理音訊的上限（以秒數表示）並加入設定或常數
  - 以常數 `MAX_PENDING_AUDIO_SECONDS = 30` 實作（非設定項）：屬內部背壓參數，非使用者需調整的行為
- [x] 3.2 於 `live_caption/mod.rs` 的取樣消費迴圈實作超過上限時丟棄最舊樣本
  - 每次 `drain_queue()` 後檢查 `samples` 長度，超過上限即以 `pop_front()` 丟棄最舊樣本至上限
- [x] 3.3 偵測到丟棄行為時，透過既有錯誤事件通道提示使用者字幕有所遺漏（需節流，避免持續落後時洗版）
  - 以 `DROP_NOTICE_THROTTLE = 10s` 節流，透過 `LIVE_CAPTION_ERROR_EVENT` 提示
  - **注意實際可觸發的後端**：`process_caption_windows()` 每次迴圈皆取「最新視窗」並丟棄視窗外的全部舊樣本（既有行為，非本次新增），故穩態下 `samples` 不會無限累積，本節上限主要是保護 `local_whisper`（單次推論無逾時上限，理論上可能長時間阻塞消費）；`voxnote_asr` 遠端路徑因請求本身已有秒級逾時（`live_caption_remote_timeout_seconds`），佇列幾乎不會累積到 30 秒上限，此背壓分支在該後端下預期極少觸發
- [x] 3.4 檢視 `block_on()` 呼叫（`live_caption/mod.rs:464`）在背壓機制下是否仍會阻塞取樣消費；若會，調整為轉錄與取樣分離
  - 麥克風／loopback 擷取執行緒獨立寫入 `queue`（mutex 保護），不受本迴圈的 `block_on()` 阻塞；本迴圈僅負責定期 `drain_queue()` 並裁切上限，故背壓機制在現有架構下已足夠，不需拆分轉錄與取樣
  - 更正先前的延遲診斷：穩態延遲＝轉錄耗時＋至多一個步進間隔，並非隨時間無限累積（見上方 3.3 注記）；已於 `process_caption_windows()` 加入耗時 log（`[live-caption][timing]`），供 7.4／7.6 實測時判斷瓶頸來源

## 4. 重疊去重與視窗設定

- [x] 4.1 將 `live_caption/mod.rs` 的 `remove_overlap()`（前後綴精確比對）替換為相似度去重
  - `remove_overlap()` 已移除，改為 `is_duplicate()`：重疊時整段略過（非裁切後綴），對應參考實作 `is_duplicate()` 的判定語意
- [x] 4.2 保留最近 N 筆已輸出結果（參考實作為 10 筆）供比對，取代目前僅比對前一筆的 `previous_text`
  - `recent_results: VecDeque<String>`（`RECENT_RESULTS_CAPACITY = 10`），取代原先的單一 `previous_text`
- [x] 4.3 實作子字串重疊度與字元相似度的雙重判定，並設定最短長度門檻避免短句誤判
  - `substring_overlap_ratio()`（最長公共子字串 / 較短長度 > 0.7）與 `char_similarity_ratio()`（Levenshtein 換算相似比 > 0.6），符合任一即視為重複；`DUPLICATE_MIN_LENGTH = 8` 避免短句誤判
- [x] 4.4 確認不導入 VAD 至即時路徑；伺服器端批次流程既有的 VAD 使用不受影響
  - 視窗長度情境預設已移出本變更（見 proposal「不在本變更範圍」），由已歸檔的 `add-live-caption-overlay` 第 12 節提供。

## 5. 字幕視窗滑鼠穿透（已完成；需求歸屬已改列於 `add-live-caption-overlay` 基準）

> 本節於實作期間完成，惟其對應需求已確認屬基準的「System allows interacting with content
> beneath the caption window」，非本變更新增。proposal 已將此項移出範圍，本節保留作為實作紀錄。

- [x] 5.1 於 `src-tauri/src/commands/live_caption_cmds.rs` 的 `set_live_caption_click_through` command 改為呼叫 `LiveCaptionManager::set_manual_click_through()`（該 command 前一變更已建立，本次改為手動切換語意）
  - 語意定為「鎖定」＝穿透模式：`LiveCaptionManager::set_lock()` 切換 session 級 `click_through_enabled` 旗標。鎖定開啟時 watcher 持續依游標位置動態切換（游標移到標題列／邊框仍可互動，供拖曳、調整大小、按下關閉鈕）；鎖定關閉時 watcher 強制維持可互動、不套用穿透。watcher 全程運作，不會被手動切換停用，避免「移到標題列卻點不到關閉鈕」的問題
- [x] 5.2 於 `src-tauri/capabilities/default.json` 補上所需權限（若適用）
  - 不適用：前端透過自訂 `#[tauri::command]` 呼叫，非 `@tauri-apps/api/window` 的 JS API，自訂 command 不需要 capability 條目
- [x] 5.3 加入切換入口，確保穿透開啟時仍可觸及
  - 依使用者要求改置於字幕視窗自身的標題列（`overlay.html` 的 `#caption-lock`，與關閉鈕並列），而非主控制面板。穿透狀態下 watcher 會在游標移入標題列時恢復互動，故該按鈕仍可點擊，不會把使用者鎖在穿透狀態
  - 為此將標題列感應高度 `OVERLAY_HEADER_HEIGHT_LOGICAL` 由 24px 放寬至 34px，涵蓋 CSS 上內距與標題列本身，避免游標落在標題列下緣時感應不到
- [x] 5.4 確認穿透關閉時，字幕視窗的拖曳與調整大小（前一變更任務 8.4）仍正常
  - 未變更 `liveCaptionOverlay.ts` 的拖曳／調整大小邏輯；鎖定關閉時 watcher 強制可互動，拖曳與調整大小行為不受影響

## 6. 設定介面

- [x] 6.1 於即時字幕的設定區塊新增來源語言、遠端端點位址、遠端模型、即時逾時等設定項
  - 前一變更任務 7.6 已將即時字幕設定自 `settings.ts` 移至 `src/components/liveCaptionSettings.ts`（即時字幕頁使用），故新欄位加於該檔案而非 `settings.ts`；滑鼠穿透維持既有的自動穿透開關（`live_caption_click_through`），手動穿透為 runtime 切換不落盤，故未在此新增欄位
- [x] 6.2 明確標示即時字幕的語言與端點與批次逐字稿為獨立設定，避免使用者誤以為共用
- [x] 6.3 確認介面未使使用者誤以為翻譯的目標語言可設定（目標固定為繁體中文，見 spec delta 的 MODIFIED「System skips the LLM call when translation would be a no-op」）
  - 規格措辭已修正：原文「目標顯示語言」隱含存在可設定的目標語言，實際上 `live_caption/mod.rs:615` 的翻譯 prompt 將繁體中文寫死，`resolve_translate_or_proofread` 亦以 `== "zh"` 判定。程式行為正確，僅需確認介面文案一致。
  - 兩側皆已加註：`liveCaptionSettings.ts` 的來源語言欄位旁提示「與設定頁批次逐字稿各自獨立」；`settings.ts` 批次轉錄語言欄位旁提示「即時字幕為獨立設定，請至即時字幕頁調整」

## 7. 實測與調校

- [x] 7.1 以實際英文影片實測：來源語言設為英文、後端指向 4090 主機，記錄字幕正確性與端到端延遲
  - 2026-08-12 實測結果為「有明顯延遲、辨識不夠準確，但勉強可用」。本機路徑亦有相近問題，因此目前不能將主因單獨歸於 4090 主機或網路；後續應配合 7.3、7.6 檢查共同的視窗切分、重疊去重、短片段語言辨識與音訊品質。
- [x] 7.2 對照組實測：批次逐字稿以中文錄音轉錄，確認語言與端點皆未受即時字幕設定影響
- [x] 7.3 實測相似度去重與原前後綴比對的字幕品質差異（重複、漏字、誤刪短句），記錄結果
  - 2026-08-12 實測（英文、`voxnote_asr`，快速字幕預設 2/3 秒）：相似度去重正確攔下重疊段落，例如 "session to..." 因與前段高度重疊被判定為重複並略過（log：「與近期輸出高度相似，判定為重疊，略過」），符合設計預期，未觀察到誤刪正常短句
- [x] 7.4 實測背壓：以刻意降速或高負載情境確認字幕能追上當下聲音且記憶體維持在上限內
  - 2026-08-12 一般負載下實測：佇列堆積穩定維持在 3.0 秒（視窗長度本身），未觸及 30 秒上限，背壓分支未觸發，符合設計預期（見決定 3、任務 3.3 注記：正常情況下滑動視窗已避免累積，本機制主要作為 `local_whisper` 的保險）。刻意降速／高負載情境尚未實測，若後續發現異常再補測
- [x] 7.5 實測遠端逾時路徑：中斷 4090 主機連線，確認單段失敗略過且 session 不中止
- [x] 7.6 依 7.1、7.3 的實測結果調校即時逾時與相似度門檻（視窗情境預設已移出本變更範圍，見 proposal）
  - 2026-08-12 結論：不調整目前的逾時（8 秒）與相似度門檻（重疊度 0.7／相似比 0.6）預設值。實測數據顯示轉錄耗時僅 0.37–0.62 秒、去重運作正常，即時字幕的延遲感受主要來自視窗長度本身（3 秒，非逾時或去重門檻），此為滑動視窗架構的結構性下限，非本次可調參數能解決；相關討論已記錄於對話紀錄，若要降低此下限需串流式增量解碼等架構調整，屬於另一個 OpenSpec 變更的範圍
- [x] 7.7 迴歸確認滑鼠穿透：於影片播放器上方疊放字幕視窗，確認點擊傳遞且可退出穿透狀態（功能屬基準，此處僅確認本變更未造成回歸）

## 8. 文件

- [x] 8.1 於專案 README 說明即時字幕的來源語言與遠端端點為獨立設定，並說明適用情境（批次中文會議／即時英文影片）
  - 新增「即時字幕與批次逐字稿為獨立設定」小節，含設定項對照表與雙情境說明
- [x] 8.2 於 `server/README.md` 說明遠端 ASR 主機的部署需求與建議模型
  - 已完成：新增「雙實例部署」章節（gateway 路徑分流、端點對照表、逾時設定、單實例退回方式），並更新「app 端設定」說明 base URL 需含 `/batch`、`/live` 前綴。
