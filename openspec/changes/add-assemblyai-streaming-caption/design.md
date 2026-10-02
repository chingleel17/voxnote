# Design

## Context

動機見 proposal.md。現有 `LiveCaptionManager` 管理互斥 session、收音與停止；`run_live_caption_session` 將 16 kHz mono `f32` 音訊送入視窗解碼迴圈。AssemblyAI 串流與 HTTP 視窗請求的語意不同，不能加在視窗辨識函式內假裝另一個批次 API。

字幕事件現以 `sequence` 覆寫段落，缺少 session 隔離與明確完成狀態；翻譯回填亦可能晚於新 session。這次新增串流時必須補齊識別，不能讓舊連線的結果覆蓋新字幕。

## Goals / Non-Goals

**Goals:**
- 可不啟動 Whisper／自架服務，以麥克風或 Windows 系統音訊測試即時字幕。
- 可用模擬服務驗證封包、partial/final、停止與翻譯回填，不需金鑰或 GPU。
- 連線與後處理皆可取消；字幕事件保持 session 與段落一致。

**Non-Goals:**
- 不新增即時講者標籤、指定應用程式收音、字幕保存、影片下載或批次轉錄功能。
- 不導入 Node/Python 常駐程序、SDK 代理或自建 token 服務。
- 不改預設後端、不自動切換雲端／本地來源、不自動重連或重播斷線前音訊。
- 不提供雲端 ASR 模型下載／更新 API；清單建議不等於模型探索端點。

## Decisions

### 1. Rust WebSocket adapter，沿用 session 與收音

新增 `src-tauri/src/live_caption/assemblyai.rs`，以 TLS-enabled `tokio-tungstenite` 實作 v3 adapter；透過 Cargo CLI 安裝相依套件與更新 lockfile，保留工作樹既有 Cargo 變更。官方主要提供 JS/Python SDK，音訊擷取既在 Rust，使用 JS SDK 反而新增跨 IPC 音訊傳輸與金鑰處理，不採用。

沿用 `start_live_caption`／`stop_live_caption`，在 `normalize_backend`、前後端 backend union 與啟動檢查增加 `assemblyai_streaming`。worker 完成音源初始化、WebSocket handshake 與 `Begin` 後才回報 ready；啟動整體期限 10 秒。失敗或使用者取消時，已建立的連線仍必須進入相同收尾流程。

擷取與 ASR 分派最小化：共同收音 queue 不改為來源專屬 ASR loop，既有本地／自架處理繼續呼叫 `process_caption_windows`，新後端呼叫串流消費器。串流端不載入模型、不探測 `/live/health`，不驗證不適用的 window/step/decode interval；音源與一般顯示／LLM 設定仍共用。

### 2. 設定與 UI

| 設定 | 決定 |
|---|---|
| `live_caption_backend` | 新增 `assemblyai_streaming`；舊預設 `local_whisper` 不變 |
| API Key | 重用 `assembly_ai_key`，Rust 從設定讀取；即時頁可編輯同一金鑰並自動遮蔽輸入 |
| `live_caption_assemblyai_model` | 新增字串，預設 `universal-3-6-pro`，與批次 `assembly_ai_speech_model` 分離 |
| 語言 | 沿用 `live_caption_language`；不改批次 `asr_language` |
| `live_caption_incremental_enabled` | 僅控制本地／自架 LocalAgreement，AssemblyAI 始終依服務端串流結果更新 |

新增欄位依既有 `serde(default)` 相容舊 TOML，Rust/TS 型別同步。即時頁沿用既有原生 select 風格：後端選單新增來源，雲端模型提供已知 U3.6/U3.5 識別建議與明確手動輸入入口，未宣稱可遠端列出模型。手動 ID 原樣送出，服務拒絕或協定不相容時回報原因，不靜默改用別的模型。

選此來源時只顯示 API Key、串流模型、來源語言及既有音源／顯示／翻譯／校稿設定；本地模型、自架端點、視窗預設、靜音視窗門檻、LocalAgreement 開關與解碼間隔隱藏，但保留設定值供切回原來源使用。開始前儲存完整目前設定，包含共享金鑰，避免用局部舊快照覆寫其他設定。

### 3. 官方協定與語言

連到 `wss://streaming.assemblyai.com/v3/ws`，Rust 使用 `Authorization` header（原始金鑰，不加 Bearer），不在 URL 放永久金鑰。TLS 必須驗證憑證；正式介面不開放任意 WebSocket endpoint。測試以注入 transport／本機 mock endpoint 執行，不改使用者設定。

固定 `sample_rate=16000`、`encoding=pcm_s16le`、`speech_model=<即時模型>`、`language_detection=true`、`session_heartbeat=true`。省略 `format_turns`，本次預設 U3.6 的完成事件已有格式化；不啟用 `speaker_labels`，維持即時字幕不標註講者。

語言為 auto 時省略 `language_codes`；明確語言送 JSON 陣列形式，例如 `language_codes=["zh"]`，由 URL query encoder 編碼。串流 `language_detection` 控制語言資訊回報，不能照搬批次 API 的語言選擇語意。`Begin.configuration.model` 若有值，須與請求模型一致；不一致或完成事件缺少必要欄位時回報協定／模型不相容，不能無限等待或自動套用另一套協定。

### 4. 音訊封包、節奏與上限

共同 queue 維持 16 kHz mono f32。以 100 ms（1,600 samples、3,200 bytes）封包傳 PCM16 little-endian binary frame；有限數值飽和到 i16 範圍，NaN/Infinity 轉為零。不得封裝 WAV、Base64 或 JSON。

即使沒有語音也持續送擷取到的靜音樣本，讓服務端負責 endpointing；這是本產品選擇，不是宣稱官方強制要求。平時不設定 `inactivity_timeout`，不新增 KeepAlive 計時器；回應 WebSocket Ping/Pong，Heartbeat 僅作連線診斷、不當字幕。

待傳 queue 上限 2 秒（32,000 samples），在 producer 入列與 consumer 側都須保護上限，避免 socket 卡住時 queue 無限成長。超過時捨棄最舊完整 sample、保留最新內容，回報字幕遺漏；連續遺漏提示最多每 5 秒一次。以牆鐘節奏每 100 ms 最多送一包，不加速補送積壓；socket write deadline 1 秒，失敗即結束 session。

進入 stopping 時先撤銷音訊入列權限，producer 在同一 queue lock 內檢查該權限；隨後取出一次性尾端快照並清空 queue，再停止 capture。即使已在執行中的 callback 稍後取得 lock，也不得再次入列。停止時只送該有限快照，不等待新音訊。最後不足 50 ms 的尾包以零補到 50 ms，其餘尾包仍在官方 50–1,000 ms 範圍內；尾包包含在停止期限內，無法送完時直接結束並記錄非文字診斷。

### 5. Turn、UI 段落與 LLM

事件以 `type` 解析 `Begin`、`Turn`、`Termination`、`Error`，可忽略未知非必要事件以相容新增訊息；格式錯誤、無法解碼的必要 Turn 或明確 Error 為 session 錯誤。

同一 `turn_order` 的 Turn 是整段替換，不串接 transcript。`words`／`word_is_final` 若可用，用於確定／暫定文字的呈現，不做 LocalAgreement。空 Turn 不顯示；跨 turn 相同短句仍顯示，不使用文字相似度刪除。

中文字幕共用已加入 Rust ASR 層的 `to_taiwan_traditional`（OpenCC `s2twp`），在產生顯示文字及 LLM 輸入前統一為台灣繁體。服務事件與 word 時間資料維持原始結構，不用轉換後的字元位置去套用原始 word 索引；英文、數字與標點不轉換。不能只依供應商 zh 語言代碼保證繁體輸出。

所有模型（含手動 ID）使用相同、明確的完成契約：Turn 的 `end_of_turn` 必須為 bool；非空且 end_of_turn=true 時 `turn_is_formatted` 必須是 bool，缺漏或型別不符即回報協定不相容並停止。end_of_turn=false 為 partial；兩者都 true 才接受 final。end_of_turn=true 但 turn_is_formatted=false 時，為該 turn 開始最多 2 秒的格式化等待，期限內可接收其他 turn，但只有相同 turn 的格式化完成可解除等待；逾時即回報模型不相容並收尾，不無限等候。空白 closing Turn 先略過，不啟動此等待。Begin 核對模型識別；capability 是否相容由第一個非空完成 Turn 驗證，不能從模型名稱猜測。

接受 first final 後保留該段的原文快照，不再讓重送 final、部分更新或後續格式化改寫原文；後處理只能增加譯文／校稿顯示。連線終止前仍未確認的文字保持暫定，不派發 LLM；停止時依清空規則移除，不把它偽造為已完成內容。

正常 U3.6 完成事件的兩個旗標皆為 true，收到即接受，不增加 2 秒延遲；上述期限僅處理未格式化完成事件的例外情況，不是所有 turn 的等待階段。

同一 `(session_id, turn_order)` 只有一個顯示段，對應穩定 `sequence`；新增 `session_id`、段內單調 `revision` 與 `phase=partial|final|postprocessed` 至共用字幕 payload，既有欄位保留。所有後端發出的 payload 與 active status 都帶 session_id，避免 sequence 重置後與舊 session 混淆。

AssemblyAI 的段落完成取決於服務端 turn，不由本地增量模式的 4 秒 timer 強制完成；長 turn 仍可即時顯示原文，但翻譯要等 final，這項延遲需實測，不宣稱等於 ASR 首次出字延遲。所有後端共用容量式歷史：依高度與字級顯示最近段落，最多保留 20 段（含當前段），不再固定只顯示 2 段。一般內容至少顯示最近歷史段與當前段；兩段換行後超出內容區高度時，保留文字並以內容區捲動閱讀，不溢出標題列、不為適應畫面強制結束 turn。原文 partial 視覺上與 final 區分。

完成段先顯示原文，再依既有 `resolve_caption_postprocess_strategy` 決定翻譯／校稿；來源 auto 仍依既有一般翻譯流程，指定中文且只開翻譯仍沿用 no-op。完成去重以 `(session_id, turn_order)`，格式化重送或相同 final 不重複呼叫 LLM。

為防慢 LLM 形成無限背景工作，串流後處理使用可取消的 async queue：最多 2 個執行中、8 個待處理項目；新項目超過上限時捨棄最舊待處理項目並保留原文，提示翻譯未跟上，ASR 繼續。語言與 prompt 規則重用現有函式，不呼叫現有無上限獨立 thread 版本。停止時清空 queue、取消本 session futures，不等待 120/600 秒 LLM timeout。

前端依 session、sequence、revision 與 phase 更新。舊 session、較舊 revision、final 之後的 partial 均忽略；晚到翻譯只更新仍保留的同段，不能重建已清空／移出的字幕，也不刷新「最後收到新語音」計時。開始與停止事件清空字幕與清空計時器。

### 6. 生命週期與失敗政策

狀態為 `connecting → running → stopping → stopped`，任何階段都可停止。worker 的 connect/read/write/等待 Begin 必須可被 cancellation 打斷，不能以不醒來的 blocking read 搭配無限 `join()`。

正常停止：先停收音及新 LLM 工作，傳尾包與 `{"type":"Terminate"}`，持續接收 final／Termination；等待終止回應最多 2 秒，超時強制關閉／drop socket。從停止命令或主視窗關閉到 worker 與 capture 清理完成總期限 5 秒，不能因網路或 LLM 卡住阻止退出。停止期間接收的 final 僅做協定收尾，不重新顯示字幕或派發付費 LLM 工作。

正常停止可清空並隱藏預先建立的 overlay 供下次使用；主視窗退出必須明確 close 隱藏視窗，再退出。停止狀態必須通知仍開啟的字幕視窗，以清除本地事件記憶體。

讀取等待以 Heartbeat／服務事件監控連線：運行中 15 秒沒有任何 server frame，視為連線失效。斷線、服務 Error、無效認證、quota/rate limit、逾時或錄音裝置失效時，一次回報遮蔽機密資訊的原因並結束；不自動重連、不回放舊音訊、不自動改用本地模型。使用者可手動重新開始，取得新的本地與服務端 session ID。

設定本地最長 session 180 分鐘，在達上限前開始同一 Terminate 流程；不等服務端強制斷線。紀錄連線是否正常終止、duration 與錯誤代碼，不能記錄金鑰、逐字稿或音訊。Streaming 按連線時間計費，開發驗收須確認停止後不再送音訊。

### 7. 與既有 changes 的協調

- `add-streaming-incremental-caption`：共享的「增量字幕」、「相似度去重」與「浮動字幕視窗」MODIFIED requirements 在兩份 delta 保持相同內容，封存任一 change 都不得退回固定兩段或刪除其他後端契約。共用 session/revision/phase 的 ADDED requirement 由本變更持有，增量 change 只引用與回歸，不重複新增。4 秒輪替及閱讀週期限本地／自架增量；AssemblyAI 依 turn，不承諾每個短 turn 固定保留 4 秒。本變更交付共用歷史與停止防回寫；本地 4 秒閱讀測試與效能驗收仍由增量 change 負責。停止後所有後端禁止字幕／LLM 新派發；本地 flush 只能內部收尾，不能恢復已清空畫面。既有勾選保留為歷史紀錄，新增契約需另列未完成任務。
- `add-live-caption-process-audio`：尚未完成的來源不列為前置依賴；將來 process audio 只需匯入共同 queue。合併時檢查 request/audio-source 分派，但本次不實作 PID 列舉。
- 交付順序為本變更 → process audio → 本地／自架剩餘調校。共用收音、辨識 consumer 分流與字幕事件已足夠，不以前置大型 ASR 框架重構阻擋串流交付；process audio 後續須沿用有界入列、停止閘門及依後端分派的靜音／錯誤政策。
- `refresh-provider-model-catalogs`：沿用其 AssemblyAI 金鑰與設定相容策略；即時模型獨立，不再誤用批次模型欄位。保留既有 UI／Cargo 的未提交修改。

## Risks / Trade-offs

- [服務費、網路與帳戶限制] → 手動選用來源、明確停止、有限 timeout；實測不在預設測試中執行。
- [長 turn 導致翻譯較晚] → 原文 partial 即時更新，驗收分開量測首次出字、final 及譯文延遲；不以強制 4 秒切句破壞服務端契約。
- [供應商協定／模型識別更新] → 確認 Begin、fixture 契約測試與遮蔽機密資訊的錯誤，不依靠 SDK 自動更新模型的假設。
- [背壓捨棄音訊或翻譯] → 明確提示遺漏、固定 queue 上限，優先追上目前播放內容。
- [舊後端事件／後處理回歸] → payload 欄位同步、session 隔離回歸測試，保留原翻譯與 LocalAgreement 策略。

## Migration Plan

1. 新增設定欄位、DTO、adapter 與模擬測試，再整合既有 manager/UI。
2. 以舊 TOML 及兩個既有來源執行回歸，接著明確啟用短時間付費串流驗收。
3. 未完成中文／英文音訊與停止驗收前，不標記交付完成、不改預設來源。
4. 回復可移除新來源程式；新設定欄位依既有 serde 寬容解析，資料庫無 migration。

## Sources

查證日期：2026-10-02，台灣台北使用情境。
- https://www.assemblyai.com/docs/streaming/select-the-speech-model
- https://www.assemblyai.com/docs/streaming/multilingual-transcription
- https://www.assemblyai.com/docs/streaming/api-spec/streaming-websocket
- https://www.assemblyai.com/docs/streaming/message-sequence
- https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures
- https://www.assemblyai.com/docs/getting-started/sdks
