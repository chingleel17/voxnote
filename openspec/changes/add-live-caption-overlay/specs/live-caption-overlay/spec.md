## Purpose

讓使用者在電腦正在播放聲音的當下，即時取得對應的繁體中文字幕，並以可疊放於任意應用程式上方的浮動視窗呈現，適用於觀看無字幕影片、參與線上會議等即時聆聽情境。

## ADDED Requirements

### Requirement: System can start and stop a live caption session

系統 MUST 允許使用者啟動與停止即時字幕 session。session 啟動後，系統 MUST 持續擷取所選音訊來源並產生字幕；停止後 MUST 釋放音訊裝置與相關資源，且不遺留任何持久化資料。

同一時間 MUST 僅允許一個即時字幕 session 存在。

#### Scenario: User starts a live caption session

- **WHEN** 使用者選擇音訊來源後啟動即時字幕
- **THEN** 系統 MUST 開始擷取該來源的音訊，開啟字幕顯示視窗，並在偵測到語音後陸續輸出字幕

#### Scenario: User stops a live caption session

- **WHEN** 使用者停止即時字幕
- **THEN** 系統 MUST 停止音訊擷取、關閉字幕顯示視窗、釋放音訊裝置，且不建立任何錄音檔或資料庫記錄

#### Scenario: User attempts to start a second session

- **WHEN** 已有即時字幕 session 進行中，使用者再次嘗試啟動
- **THEN** 系統 MUST 拒絕啟動並回報「已有即時字幕進行中」，既有 session MUST 不受影響

#### Scenario: User starts live captions while a recording is in progress

- **WHEN** 桌面錄音進行中，使用者嘗試啟動即時字幕
- **THEN** 系統 MUST 拒絕啟動並回報錄音進行中，進行中的錄音 MUST 不受影響

#### Scenario: User starts a recording while live captions are active

- **WHEN** 即時字幕 session 進行中，使用者嘗試開始桌面錄音
- **THEN** 系統 MUST 拒絕開始錄音並回報即時字幕進行中，進行中的字幕 session MUST 不受影響

### Requirement: System captures audio from the user-selected source

系統 MUST 支援以電腦系統音訊或麥克風作為即時字幕的音訊來源。在不支援系統音訊擷取的平台上，系統 MUST 明確告知該來源不可用，而非靜默失敗或產生空白字幕。

#### Scenario: User captures computer playback audio

- **WHEN** 使用者於支援的平台選擇「電腦音訊」來源並啟動即時字幕，且電腦正在播放含語音的內容
- **THEN** 系統 MUST 依據該播放內容產生字幕

#### Scenario: System audio is unavailable on the platform

- **WHEN** 使用者在不支援系統音訊擷取的平台選擇「電腦音訊」來源
- **THEN** 系統 MUST 在啟動前告知該來源於目前平台不可用，並不啟動 session

### Requirement: System produces captions incrementally from a continuous audio stream

系統 MUST 將持續的音訊串流切分為時間視窗並逐段轉錄，使字幕在聆聽過程中陸續出現，而非等待音訊結束。相鄰視窗之間 MUST 有重疊，以降低邊界處語句被切斷造成的漏字。

系統 MUST 略過音量低於靜音門檻的視窗，不對其發出轉錄請求。

#### Scenario: Captions appear while audio is still playing

- **WHEN** 使用者啟動即時字幕且音訊持續播放
- **THEN** 系統 MUST 在音訊尚未結束前即陸續輸出字幕，且每段字幕輸出後 MUST 繼續處理後續音訊

#### Scenario: Audio contains a silent passage

- **WHEN** 音訊進入無語音的靜音片段
- **THEN** 系統 MUST 不對該片段發出轉錄請求，且 MUST 不產生空白或無意義的字幕

### Requirement: System supports switchable transcription backends for live captions

系統 MUST 允許使用者選擇即時字幕的轉錄後端：本地轉錄引擎或自架 ASR 服務。切換後端 MUST 不影響既有批次逐字稿流程所使用的轉錄設定。

當所選後端未正確設定或無法使用時，系統 MUST 於啟動時回報可理解的錯誤原因，而非在 session 開始後才靜默失敗。

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

### Requirement: System can translate captions into Traditional Chinese

系統 MUST 提供將轉錄結果翻譯為繁體中文（台灣用語）後顯示的選項。使用者 MUST 能關閉翻譯以直接顯示原文，並 MUST 能選擇同時顯示原文與譯文。

翻譯失敗時，系統 MUST 顯示未翻譯的原文，而非丟棄該段字幕。

#### Scenario: User watches foreign-language content with translation enabled

- **WHEN** 使用者啟用翻譯並播放非中文語音內容
- **THEN** 系統 MUST 顯示該段語音對應的繁體中文譯文

#### Scenario: User disables translation

- **WHEN** 使用者關閉翻譯選項
- **THEN** 系統 MUST 直接顯示轉錄所得的原文，且 MUST 不發出翻譯請求

#### Scenario: Translation request fails

- **WHEN** 某段字幕的翻譯請求失敗
- **THEN** 系統 MUST 顯示該段的原文並繼續處理後續字幕，MUST 不中止 session

### Requirement: System displays captions in an always-on-top floating window

系統 MUST 以獨立的浮動視窗顯示即時字幕。該視窗 MUST 永遠置於其他視窗之上，MUST 可由使用者移動與調整大小，且 MUST 不出現於工作列的獨立項目干擾主視窗操作。

字幕視窗 MUST 僅保留最近的若干段字幕，較舊的內容 MUST 隨新字幕產生而捲離，避免無限增長。保留行數 MUST 可由使用者設定。

當距離最後一段字幕超過使用者設定的秒數仍未產生新字幕時，字幕視窗 MUST 清空既有內容，避免舊字幕長時間停留在畫面上。該秒數 MUST 可由使用者設定，且 MUST 支援設為零以停用自動清空。

#### Scenario: User overlays captions on a video player

- **WHEN** 使用者啟動即時字幕並將字幕視窗拖曳至影片播放器上方
- **THEN** 字幕視窗 MUST 持續顯示於影片播放器之上，即使使用者點擊影片播放器使其取得焦點

#### Scenario: Captions accumulate over a long session

- **WHEN** 即時字幕 session 長時間執行並產生大量字幕
- **THEN** 字幕視窗 MUST 僅保留最近的字幕內容，且 MUST 不因內容累積而持續消耗記憶體

#### Scenario: Audio goes silent for an extended period

- **WHEN** 影片暫停或音訊靜音達到使用者設定的清空秒數且期間未產生新字幕
- **THEN** 字幕視窗 MUST 清空既有字幕並回到等待狀態

#### Scenario: User disables automatic clearing

- **WHEN** 使用者將清空秒數設為零
- **THEN** 字幕 MUST 持續保留最近的若干行，MUST 不因長時間無語音而清空

### Requirement: System allows interacting with content beneath the caption window

字幕視窗 MUST 提供點擊穿透，使使用者能直接操作視窗下方的影片播放器。點擊穿透 MUST 可由使用者停用。

啟用點擊穿透時，字幕文字區域 MUST 讓滑鼠事件穿透至下層視窗；標題列與視窗邊框感應區 MUST 在游標移入時恢復互動，使拖曳、調整大小與關閉等操作仍可執行。

字幕視窗 MUST 可由視窗四邊與四角的邊框感應區調整大小，MUST 不僅依賴單一角落的控制點。

#### Scenario: User clicks a video player beneath the captions

- **WHEN** 點擊穿透啟用且使用者點擊字幕文字所覆蓋的影片區域
- **THEN** 該點擊 MUST 傳遞至影片播放器，MUST 不被字幕視窗攔截

#### Scenario: User moves the cursor to the caption window border

- **WHEN** 點擊穿透啟用且使用者將游標移至字幕視窗的標題列或邊框感應區
- **THEN** 字幕視窗 MUST 恢復接收滑鼠事件，使用者 MUST 能拖曳視窗、調整大小或關閉字幕

#### Scenario: User disables click-through

- **WHEN** 使用者停用點擊穿透
- **THEN** 字幕視窗整體 MUST 恢復接收滑鼠事件

### Requirement: System applies caption settings on the next session

即時字幕的設定 MUST 由即時字幕頁提供，MUST 不要求使用者前往設定頁調整。

啟動字幕前，系統 MUST 先將未儲存的設定寫入設定檔，確保本次啟動採用使用者當前所見的設定值。

字幕進行中變更設定時，系統 MUST 告知使用者需停止並重新開始字幕才會套用。

#### Scenario: User changes settings then starts captions

- **WHEN** 使用者在即時字幕頁調整參數後立即按下開始
- **THEN** 系統 MUST 先儲存設定再啟動，本次 session MUST 採用新設定值

#### Scenario: User changes settings while captions are running

- **WHEN** 使用者於字幕進行中變更設定
- **THEN** 系統 MUST 顯示需重新啟動才會套用的提示

### Requirement: System reports live caption failures without terminating silently

當音訊擷取中斷、轉錄後端連續失敗或裝置失效時，系統 MUST 向使用者回報可理解的原因。單次轉錄失敗 MUST 不中止整個 session；僅在無法繼續擷取音訊時，系統才 MUST 結束 session 並告知原因。

#### Scenario: A single transcription request fails

- **WHEN** 某個音訊視窗的轉錄請求失敗
- **THEN** 系統 MUST 略過該段並繼續處理後續音訊，MUST 不結束 session

#### Scenario: Audio capture device becomes unavailable

- **WHEN** session 進行中，所選音訊裝置失效或被移除
- **THEN** 系統 MUST 結束 session、關閉字幕視窗，並向使用者顯示指出裝置失效的錯誤原因

### Requirement: Live captions are ephemeral and not persisted

即時字幕 MUST 為純即時內容。系統 MUST NOT 將字幕文字寫入資料庫，MUST NOT 產生錄音檔，且 session 結束後 MUST NOT 留存任何字幕內容。

#### Scenario: Session ends

- **WHEN** 即時字幕 session 結束
- **THEN** 系統 MUST NOT 於資料庫、錄音清單或檔案系統中留下該次字幕的任何記錄

### Requirement: Live captions do not provide speaker diarization

即時字幕 MUST NOT 標註語者身分。此限制源於分段轉錄無法維持跨段一致的語者分群結果，標註反而會產生誤導。既有批次逐字稿的語者分離功能 MUST 不受本限制影響。

#### Scenario: Multiple speakers appear in live captions

- **WHEN** 即時字幕擷取的音訊包含多位說話者
- **THEN** 系統 MUST 輸出不含語者標籤的字幕文字

#### Scenario: Batch transcription retains diarization

- **WHEN** 使用者對既有錄音執行批次逐字稿並啟用語者分離
- **THEN** 該流程 MUST 仍依原有行為輸出含語者標籤的逐字稿
