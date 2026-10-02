## MODIFIED Requirements

### Requirement: System can start and stop a live caption session

系統 MUST 允許使用者啟動與停止即時字幕 session。session 啟動後，系統 MUST 持續擷取所選音訊來源並產生字幕；停止後 MUST 釋放音訊裝置、串流連線與相關資源，且不遺留任何持久化資料。

同一時間 MUST 僅允許一個即時字幕 session 存在。正常停止 MUST 清空字幕，並隱藏可重用的浮動視窗或將其關閉；應用程式退出則 MUST 明確關閉該視窗。雲端串流 MUST 遵循 `assemblyai-streaming-caption` 的有限時間收尾，不因等待服務而阻止停止。

#### Scenario: User starts a live caption session
- **WHEN** 使用者選擇音訊來源後啟動即時字幕
- **THEN** 系統 MUST 開始擷取該來源的音訊，開啟字幕顯示視窗，並在偵測到語音後陸續輸出字幕

#### Scenario: User stops a live caption session
- **WHEN** 使用者停止即時字幕
- **THEN** 系統 MUST 停止音訊擷取、釋放音訊與串流資源、清空並隱藏或關閉字幕視窗，且不建立任何錄音檔或資料庫記錄

#### Scenario: User attempts to start a second session
- **WHEN** 已有即時字幕 session 進行中，使用者再次嘗試啟動
- **THEN** 系統 MUST 拒絕啟動並回報「已有即時字幕進行中」，既有 session MUST 不受影響

#### Scenario: User starts live captions while a recording is in progress
- **WHEN** 桌面錄音進行中，使用者嘗試啟動即時字幕
- **THEN** 系統 MUST 拒絕啟動並回報錄音進行中，進行中的錄音 MUST 不受影響

#### Scenario: User starts a recording while live captions are active
- **WHEN** 即時字幕 session 進行中，使用者嘗試開始桌面錄音
- **THEN** 系統 MUST 拒絕開始錄音並回報即時字幕進行中，進行中的字幕 session MUST 不受影響

#### Scenario: Application is closed while a live caption session is running
- **WHEN** 即時字幕 session 進行中，使用者關閉應用程式主視窗
- **THEN** 系統 MUST 停止音訊擷取、背景工作與串流連線、釋放音訊裝置，並明確關閉（而非僅隱藏）字幕浮動視窗

### Requirement: System produces captions incrementally from a continuous audio stream

系統 MUST 在聆聽過程中陸續產生字幕，而非等待音訊結束。本地／自架後端 MUST 將持續音訊切分為重疊時間視窗，以降低語句邊界漏字。

本地／自架增量模式啟用時，系統 MUST NOT 以「視窗填滿」作為輸出前提，改由 `streaming-caption-decoding` 的一致性判定決定；增量模式關閉時 MUST 以完整視窗輸出。該兩類後端 MUST 略過音量低於靜音門檻的視窗，不對其發出轉錄請求。

AssemblyAI 串流 MUST 直接傳送連續、不重疊音訊，並依服務端 Turn 更新字幕，MUST NOT 等待視窗填滿、套用 LocalAgreement 或因本地增量開關而退回 HTTP 視窗路徑。串流可持續傳送靜音樣本，但空白事件 MUST 不產生字幕。

#### Scenario: Captions appear while audio is still playing
- **WHEN** 使用者啟動即時字幕且音訊持續播放
- **THEN** 系統 MUST 在音訊尚未結束前即陸續輸出字幕，且每段字幕輸出後 MUST 繼續處理後續音訊

#### Scenario: Audio contains a silent passage
- **WHEN** 音訊進入無語音的靜音片段
- **THEN** 本地／自架後端 MUST 不對該靜音視窗發出轉錄請求；AssemblyAI 可繼續傳送靜音樣本，但所有後端 MUST 不產生空白或無意義字幕

#### Scenario: Caption appears before its window has filled
- **WHEN** 本地／自架增量模式啟用且某段語音所屬的視窗尚未填滿
- **THEN** 系統 MUST 在視窗填滿之前即輸出該語音中已穩定的文字，MUST NOT 等待視窗填滿

#### Scenario: AssemblyAI streams independently of the local incremental switch
- **WHEN** 使用者選擇 AssemblyAI 串流，不論本地增量開關原值為何
- **THEN** 系統 MUST 依服務端暫定及完成事件持續更新，不重複解碼音訊視窗

### Requirement: System supports switchable transcription backends for live captions

系統 MUST 允許使用者選擇即時字幕後端：本地轉錄引擎、自架 ASR 服務或 AssemblyAI 串流。切換 MUST 不影響批次逐字稿所選後端、模型與語言；AssemblyAI 金鑰為共享認證設定。

所選後端未正確設定或不可用時，系統 MUST 於啟動時回報可理解的原因，而非 session 開始後靜默失敗；MUST NOT 未經使用者選擇即自動切換後端。

#### Scenario: User selects the local transcription backend
- **WHEN** 使用者選擇本地轉錄引擎並已指定可用的本地模型檔
- **THEN** 系統 MUST 以該本地引擎轉錄即時字幕，且 MUST 不將音訊傳送至任何外部服務

#### Scenario: Local model cannot be loaded
- **WHEN** 使用者選擇本地轉錄引擎，但模型檔未指定、路徑不存在、格式不符或裝置記憶體不足以載入
- **THEN** 系統 MUST 拒絕啟動 session，並回報指出載入失敗原因的錯誤訊息

#### Scenario: Self-hosted ASR service is unreachable
- **WHEN** 使用者選擇自架 ASR 服務後端，但服務位址未設定或無法連線
- **THEN** 系統 MUST 拒絕啟動 session，並回報指出連線失敗的錯誤訊息

#### Scenario: Live caption backend differs from batch transcription backend
- **WHEN** 使用者將即時字幕後端設為本地引擎，而批次逐字稿的 ASR 供應商設為其他來源
- **THEN** 兩者 MUST 各自使用其所選後端，互不影響

#### Scenario: AssemblyAI starts without a local model
- **WHEN** 使用者選擇 AssemblyAI 串流且金鑰、音源和串流模型有效
- **THEN** 系統 MUST 能啟動，不要求本地模型檔、自架服務或 GPU

### Requirement: System resolves the live caption endpoint at session start

本需求的自動判定 MUST 僅用於自架 ASR 後端。自架即時字幕遠端位址未設定時，系統 MUST 於 session 啟動時自動判定位址，MUST NOT 要求使用者理解服務路徑配置。

判定 MUST 僅於啟動時進行一次，MUST NOT 於每次轉錄前重複進行。明確填寫位址時 MUST 直接採用，MUST NOT 以自動判定覆蓋。

判定失敗（無法連線、逾時或非成功回應）時 MUST 回退至批次自架位址，MUST NOT 因判定本身失敗拒絕啟動；實際位址仍依健康檢查把關。判定結果 MUST NOT 寫回設定檔。

AssemblyAI MUST 使用其官方串流端點，MUST NOT 探測自架 `/live/health` 或退回批次自架位址。

#### Scenario: Endpoint is unset and the service provides a dedicated live path
- **WHEN** 使用者未填寫自架即時字幕位址，而批次自架位址提供專供即時字幕的子路徑
- **THEN** 系統 MUST 於本次 session 採用該子路徑，使即時字幕使用適合其用途的模型實例

#### Scenario: Endpoint is unset and the service has no dedicated live path
- **WHEN** 自架即時字幕位址未填寫且批次服務沒有該子路徑
- **THEN** 系統 MUST 沿用批次自架位址並正常啟動 session

#### Scenario: User has explicitly configured an endpoint
- **WHEN** 使用者已明確填寫自架即時字幕位址
- **THEN** 系統 MUST 直接採用該位址，MUST NOT 自動判定或改用其他位址

#### Scenario: Automatic detection cannot reach the service
- **WHEN** 自架自動判定期間無法連線或逾時
- **THEN** 系統 MUST 回退至批次自架位址繼續啟動，MUST NOT 因判定失敗本身中止

#### Scenario: Detection result is not persisted
- **WHEN** 系統完成自架位址自動判定並啟動
- **THEN** 設定檔中的即時字幕位址 MUST 維持原本未設定狀態

#### Scenario: Cloud streaming does not probe the self-hosted service
- **WHEN** 選擇 AssemblyAI 串流
- **THEN** 系統 MUST 不查詢批次／即時自架服務位址

### Requirement: Live captions use a remote ASR endpoint independent of batch transcription

自架即時字幕 MUST 具備專屬服務位址設定，與批次自架 ASR 位址各自獨立，使兩者可指向不同模型實例。自架即時位址未設定時依 session 啟動自動判定；實際採用位址無法連線時 MUST 於啟動回報錯誤，不靜默失敗。

AssemblyAI 串流使用官方端點和專屬串流模型，MUST NOT 受批次自架位址或批次 AssemblyAI 模型設定影響。

#### Scenario: Live caption and batch transcription point to different services
- **WHEN** 使用者將批次指向繁中模型的自架服務，並將即時字幕指向英文低延遲自架服務
- **THEN** 兩者 MUST 各自向所設定的位址發出請求，互不影響

#### Scenario: Live caption remote endpoint is unreachable at startup
- **WHEN** 使用者選擇自架後端啟動，但依明確設定或自動判定所得的位址無法使用
- **THEN** 系統 MUST 拒絕啟動並回報該位址連線失敗的原因

### Requirement: Remote live caption requests use timeouts suited to real-time cadence

自架 HTTP 視窗式遠端請求 MUST 使用適用即時節奏的逾時上限，與批次長錄音分離。單一視窗逾時 MUST 放棄並繼續後續音訊，MUST NOT 中止 session 或重試該視窗。

系統 MUST 於同一 session 重複使用連線資源發出 HTTP 視窗請求，不為每窗重建。AssemblyAI WebSocket 不套用單窗逾時規則，MUST 依其串流啟動、write、存活與停止期限處理。

#### Scenario: A single remote request exceeds the real-time timeout
- **WHEN** 自架某視窗請求超過即時逾時上限仍未回應
- **THEN** 系統 MUST 放棄該視窗、繼續後續音訊，MUST NOT 因此中止 session

#### Scenario: Batch transcription timeout is unaffected
- **WHEN** 自架即時字幕採秒級逾時
- **THEN** 批次長錄音請求 MUST 維持原逾時上限，不受即時設定影響

#### Scenario: Multiple windows are transcribed within one session
- **WHEN** 單一自架 session 連續處理多個視窗
- **THEN** 系統 MUST 重複使用同一組連線資源，MUST NOT 為每窗重建

### Requirement: System deduplicates overlapping caption results by similarity

本地／自架非增量視窗因重疊而可能產生字面略異但相同的語音結果。系統 MUST 以相似度比對最近數筆結果判定重複，MUST NOT 僅依前後綴精確比對或僅比對前一筆，並 MUST 避免誤刪過短文字。

本地／自架增量模式的重疊由 `streaming-caption-decoding` 一致性判定處理，整段相似度去重 MUST NOT 重複套用。AssemblyAI 串流以 session 及 turn 識別覆寫／去重，MUST NOT 套用 LocalAgreement 或全文相似度，避免不同 turn 的相同發言被刪除。

#### Scenario: Same speech is recognized slightly differently across windows
- **WHEN** 本地／自架增量模式關閉，且相鄰視窗對同語音產生字面略異但內容相同的結果
- **THEN** 系統 MUST 判定重複且不重複輸出

#### Scenario: Duplicate content matches an earlier result rather than the immediately previous one
- **WHEN** 本地／自架增量模式關閉，某字幕與前數筆而非緊鄰前一筆內容重複
- **THEN** 系統 MUST 判定重複且不重複輸出

#### Scenario: Two short phrases differ only slightly but are genuinely different
- **WHEN** 兩段極短文字字面相近但實為不同內容
- **THEN** 系統 MUST 不誤判重複，兩者 MUST 皆輸出

#### Scenario: Incremental mode handles overlap without similarity deduplication
- **WHEN** 本地／自架增量模式啟用且連續解碼有重疊結果
- **THEN** 重疊 MUST 由一致性判定處理，整段相似度 MUST NOT 額外套用於確定文字

#### Scenario: AssemblyAI turns replace rather than append
- **WHEN** 同一 AssemblyAI turn 更新文字
- **THEN** 系統 MUST 覆寫同段；不同 turn 即使文字相同也 MUST 不被去重

### Requirement: Caption window length is configurable via scenario presets

本地／自架視窗式字幕 MUST 允許使用者調整視窗長度與步進，並提供線上會議、教育訓練、演講簡報、快速字幕等情境預設，使一般使用者無須直接輸入秒數。相鄰視窗 MUST 重疊；進階使用者 MAY 展開精確調整，但非預設可見路徑。

AssemblyAI 串流以服務端分段，不使用本地視窗預設；選取該後端時，視窗、步進、LocalAgreement 開關及解碼間隔控制 MUST 隱藏，原設定值 MUST 保留供切回原後端使用。

#### Scenario: User watches fast-paced English content
- **WHEN** 使用本地／自架視窗字幕觀看快速語音且常在句中切斷
- **THEN** 使用者 MUST 能選較長視窗情境改善完整度，不須先理解視窗長度／步進

#### Scenario: User prioritizes lowest latency
- **WHEN** 使用本地／自架視窗字幕且希望更早出字
- **THEN** 使用者 MUST 能選較短視窗情境

#### Scenario: User wants precise control over parameters
- **WHEN** 本地／自架使用者希望精確調整視窗與步進
- **THEN** 系統 MUST 提供可展開進階控制，不完全移除精確調整能力

#### Scenario: User changes back from streaming
- **WHEN** 使用者由 AssemblyAI 切回本地／自架字幕
- **THEN** 原視窗及增量設定 MUST 恢復顯示，且值不被雲端來源覆寫

### Requirement: System reports live caption failures without terminating silently

音訊擷取中斷、後端失敗或裝置失效時 MUST 回報可理解的原因。視窗式後端的單次請求失敗 MUST 略過而繼續；裝置不可用或 AssemblyAI 串流連線已不可繼續時 MUST 結束 session 並清理資源。

AssemblyAI 斷線、認證、服務、傳輸或存活逾時錯誤 MUST 明確回報，MUST NOT 在沒有有效連線時仍顯示執行中；第一版不自動重連或切換來源。

#### Scenario: A single transcription request fails
- **WHEN** 本地／自架某音訊視窗的轉錄請求失敗
- **THEN** 系統 MUST 略過並繼續後續音訊，MUST 不結束 session

#### Scenario: Audio capture device becomes unavailable
- **WHEN** session 進行中，所選音訊裝置失效或被移除
- **THEN** 系統 MUST 結束 session、清理字幕視窗與資源，顯示裝置失效原因

#### Scenario: Streaming backend connection fails
- **WHEN** AssemblyAI 連線失效或回報不可繼續的錯誤
- **THEN** 系統 MUST 有限時間內結束並提示原因，不靜默改來源；使用者可手動重啟

### Requirement: System displays captions in an always-on-top floating window

系統 MUST 以獨立的浮動視窗顯示即時字幕。該視窗 MUST 永遠置於其他視窗之上，MUST 可由使用者移動與調整大小，且 MUST 不出現於工作列的獨立項目干擾主視窗操作。

所有後端的字幕視窗 MUST 區分「已完成歷史段」與「目前正在更新的當前段」，最多保留 20 段（含當前段）。一般內容的最小視窗 MUST 至少同時顯示 1 個歷史段與 1 個當前段；放大視窗時 MUST 依高度與字級增加可見歷史段數，MUST NOT 固定只顯示 2 段。尚無歷史段時 MUST NOT 建立空白佔位字幕。

空間不足時 MUST 優先減少可見的最舊歷史段，保留最近 1 個歷史段與當前段。若這兩段本身已超過內容區高度，MUST 保留全文並提供內容區捲動閱讀，MUST NOT 蓋住標題列、溢出視窗或為適應畫面強制結束辨識段。容量內未顯示的歷史可在放大時重新顯示；達資料上限移除或自動清空的段落 MUST NOT 因晚到譯文而復活。

使用者調整字幕視窗大小或變更字級時，系統 MUST 重新計算可顯示的歷史段數。視窗變高或字級變小時 MUST 能顯示更多仍保留的歷史段；視窗變矮或字級變大時 MAY 減少最舊可見歷史段，但 MUST 維持前述最近兩段與超長內容捲動規則。

單段字幕的文字長度超過視窗寬度時 MUST 自動換行完整顯示，MUST NOT 截斷或省略內容。

本地／自架增量或 AssemblyAI 串流啟用時，字幕視窗 MUST 區分暫定與穩定文字；暫定修正 MUST 就地更新，不增加段數。更新 MUST 遵循共用 session、sequence、revision 與 phase 隔離；段內 confirmed MUST NOT 被誤認為整段 final。

本地／自架增量模式的當前段 MUST 每 4 秒完成並成為歷史段，後續文字 MUST 使用新的 `sequence` 顯示於新的當前段。LocalAgreement 的確定狀態 MUST NOT 使同一列無限存活。最小視窗下，完成段成為歷史段後 MUST 至少保持可見一個完整顯示週期（4 秒），直到下一段完成後才可被更舊段落取代。AssemblyAI 串流的完成由服務端 turn 決定，MUST NOT 以此本地計時器強制完成；暫定文字的視覺區分及就地更新仍適用於該後端。

無新語音字幕達使用者設定秒數時 MUST 清空；零 MUST 停用自動清空。翻譯／校稿回填與相同事件重送 MUST NOT 重設此計時；開始與停止 session MUST 清空字幕及計時器，不受零值設定影響。

#### Scenario: User overlays captions on a video player

- **WHEN** 使用者啟動即時字幕並將字幕視窗拖曳至影片播放器上方
- **THEN** 字幕視窗 MUST 持續顯示於影片播放器之上，即使使用者點擊影片播放器使其取得焦點

#### Scenario: Captions accumulate over a long session

- **WHEN** 即時字幕 session 長時間執行並產生大量字幕
- **THEN** 字幕視窗 MUST 僅保留最近的字幕內容，且 MUST 不因內容累積而持續消耗記憶體

#### Scenario: User enlarges the caption window

- **WHEN** 使用者增加字幕視窗高度，且有更多歷史段可供顯示
- **THEN** 系統 MUST 增加可見歷史段數，MUST NOT 永遠只顯示固定 2 段

#### Scenario: Audio goes silent for an extended period

- **WHEN** 影片暫停或音訊靜音達到使用者設定的清空秒數且期間未產生新字幕
- **THEN** 字幕視窗 MUST 清空既有字幕並回到等待狀態

#### Scenario: User disables automatic clearing

- **WHEN** 使用者將清空秒數設為零
- **THEN** 字幕 MUST 持續保留最近的若干行，MUST 不因長時間無語音而清空

#### Scenario: New caption appears while the previous one is still readable

- **WHEN** 本地／自架增量模式的目前段完成並建立新的當前段
- **THEN** 前一完成段 MUST 作為歷史段與新當前段並存，且在最小視窗下 MUST 至少持續可見 4 秒，MUST NOT 被新段立即取代消失

#### Scenario: Window is too small to fully show the retained captions

- **WHEN** 字幕視窗當下高度不足以完整顯示所有歷史段
- **THEN** 系統 MUST 先減少最舊可見歷史；最近歷史段與當前段仍過長時 MUST 可在內容區捲動閱讀全文，不蓋住標題列或溢出視窗

#### Scenario: User resizes the caption window

- **WHEN** 使用者於 session 進行中放大字幕視窗
- **THEN** 系統 MUST 重新計算容量並顯示更多仍在歷史上限內的完成段落

#### Scenario: A single caption is longer than the window width

- **WHEN** 某段字幕的文字長度超過字幕視窗寬度
- **THEN** 該段字幕 MUST 自動換行完整顯示，MUST NOT 被截斷或以省略號略去內容

#### Scenario: Tentative text is visually distinguishable from confirmed text

- **WHEN** 本地／自架增量或 AssemblyAI 串流的字幕視窗同時顯示暫定與穩定文字
- **THEN** 兩者 MUST 在視覺上可被使用者區分，使使用者能辨識哪些內容可能仍會變動

#### Scenario: Tentative text is revised in place

- **WHEN** 某段暫定文字被後續解碼修正
- **THEN** 字幕視窗 MUST 就地更新該段文字，MUST NOT 將其視為新的一段而使前一段字幕提前捲離

## ADDED Requirements

### Requirement: Caption updates are isolated by session and segment revision

字幕與後處理更新 MUST 可辨識所屬 session、段落及修訂版本，且完成／暫定狀態 MUST 明確。新 session 開始與停止時 MUST 清空舊字幕；舊 session 或較舊版本 MUST NOT 覆蓋新內容，已完成段 MUST NOT 退回暫定。

晚到譯文只能更新仍保留的同段，MUST NOT 讓已清空或捲離的字幕再次出現；譯文回填 MUST NOT 重設無新語音自動清空計時。

此契約 MUST 適用所有辨識後端與音源。進入 stopping 後 MUST 不再派發新的字幕或 LLM 工作；本地解碼器可在內部完成暫定文字收尾，但 MUST NOT 恢復已清空的畫面。段內文字已由 LocalAgreement 確認，不代表整段 phase 已為 final；整段完成由各後端的完成政策決定。

#### Scenario: A previous session finishes translation late
- **WHEN** 新 session 已啟動，前一 session 的翻譯才完成
- **THEN** 系統 MUST 忽略舊結果，不覆蓋新字幕

#### Scenario: A stale partial follows a completed turn
- **WHEN** 已完成段收到較舊暫定更新
- **THEN** 系統 MUST 保留完成狀態與較新內容

#### Scenario: Translation arrives after automatic clearing
- **WHEN** 無語音清空已執行後收到舊段譯文
- **THEN** 系統 MUST 不恢復舊字幕，也不重置語音清空時間

#### Scenario: Local decoding finishes after stopping
- **WHEN** 本地／自架解碼或暫定文字 flush 在 session 進入 stopping 後完成
- **THEN** 系統 MUST 僅內部收尾，不新增字幕或 LLM 工作，且不得回填之後的新 session
