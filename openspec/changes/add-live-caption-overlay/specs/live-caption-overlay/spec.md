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

### Requirement: System suppresses low-confidence and hallucinated transcription output

轉錄模型在音訊資訊不足時會輸出與實際語音無關的文字（常見為訓練資料中的影片結尾套語）。系統 MUST 濾除此類輸出，MUST NOT 將其顯示為字幕。

系統 MUST 依轉錄後端所提供的信心指標判定是否採信該段結果，而非僅依賴文字內容比對。當後端提供的抑制參數在該版本未實作而不生效時，系統 MUST 自行實施等效的判定，MUST NOT 因設定了無效參數即視為已完成把關。

文字內容的比對 MUST 以完整片語為單位，MUST NOT 因單一常用詞出現即濾除正常語音。

#### Scenario: Model emits a video outro phrase for speech-free audio

- **WHEN** 某個視窗的音訊不含可辨識語音，而模型輸出影片結尾套語
- **THEN** 系統 MUST 濾除該段，MUST NOT 顯示為字幕

#### Scenario: Segment confidence indicates absence of speech

- **WHEN** 轉錄後端回報某段的非語音機率高於系統所定上限
- **THEN** 系統 MUST 略過該段，MUST NOT 將其文字輸出為字幕

#### Scenario: Ordinary speech contains words that also appear in hallucination phrases

- **WHEN** 正常語音中出現的詞彙同時也是幻覺套語的組成詞
- **THEN** 系統 MUST NOT 濾除該段，該段字幕 MUST 正常輸出

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

### Requirement: Translation and proofreading are independent options

即時字幕的「翻譯」與「校稿」MUST 為兩個獨立開關，使用者 MUST 能單獨開啟或關閉其中之一，MUST NOT 被迫綁定為單一選項。

**翻譯**：系統 MUST 提供將轉錄結果翻譯為繁體中文（台灣用語）後顯示的選項。使用者 MUST 能關閉翻譯以直接顯示原文，並 MUST 能選擇同時顯示原文與譯文。翻譯失敗時，系統 MUST 顯示未翻譯的原文，而非丟棄該段字幕。

**校稿**：系統 MUST 提供以模型修正單段轉錄結果中常見辨識錯誤（同音字誤植、缺漏標點、斷句不順）的選項，輸出語言與輸入語言相同，不涉及翻譯。校稿失敗時，系統 MUST 顯示未校稿的原文，而非丟棄該段字幕。

#### Scenario: User watches foreign-language content with translation enabled

- **WHEN** 使用者啟用翻譯並播放非中文語音內容
- **THEN** 系統 MUST 顯示該段語音對應的繁體中文譯文

#### Scenario: User disables translation

- **WHEN** 使用者關閉翻譯選項
- **THEN** 系統 MUST 直接顯示轉錄所得的原文，且 MUST NOT 發出翻譯請求

#### Scenario: Translation request fails

- **WHEN** 某段字幕的翻譯請求失敗
- **THEN** 系統 MUST 顯示該段的原文並繼續處理後續字幕，MUST NOT 中止 session

#### Scenario: User enables proofreading for same-language content

- **WHEN** 使用者針對中文會議內容啟用校稿（不啟用翻譯）
- **THEN** 系統 MUST 顯示校正同音字、標點與斷句後的中文字幕，MUST NOT 將內容翻譯為其他語言

#### Scenario: User enables both translation and proofreading with different languages

- **WHEN** 使用者同時啟用翻譯與校稿，且來源語言與目標顯示語言不同
- **THEN** 系統 MUST 僅執行翻譯並顯示譯文，校稿選項於此情境下 MUST NOT 生效（校稿以「輸出語言與輸入語言相同」為前提，跨語言情境無意義）

#### Scenario: Proofreading request fails

- **WHEN** 某段字幕的校稿請求失敗
- **THEN** 系統 MUST 顯示該段未校稿的原文並繼續處理後續字幕，MUST NOT 中止 session

### Requirement: System skips the LLM call when translation would be a no-op

僅啟用翻譯（未啟用校稿）時，若目標顯示語言與來源語言相同，系統 MUST NOT 呼叫翻譯模型，MUST 直接顯示轉錄原文。此為節省延遲與費用的最佳化，翻譯開關本身的其餘行為不受影響。

#### Scenario: Target language equals source language with only translation enabled

- **WHEN** 使用者啟用翻譯、未啟用校稿，且目標顯示語言與轉錄來源語言相同
- **THEN** 系統 MUST 直接顯示轉錄原文，MUST NOT 對該段發出翻譯請求

#### Scenario: Target language equals source language with both enabled

- **WHEN** 使用者同時啟用翻譯與校稿，且目標顯示語言與來源語言相同
- **THEN** 系統 MUST 執行校稿並顯示校正後的原語言字幕，此情境 MUST NOT 被本最佳化跳過（此時校稿本身即為使用者要的處理，見「Translation and proofreading are independent options」的同語言校稿情境）

### Requirement: Live caption proofreading shares its prompt with batch transcript proofreading

即時字幕的校稿與批次逐字稿校稿 MUST 使用共同的核心指示（修正同音字誤植、缺漏標點、斷句不順），MUST NOT 各自維護獨立且可能不一致的校正邏輯。

即時字幕的校稿 MUST NOT 要求或依賴批次校稿專屬的格式標記（例如時間戳記 `[MM:SS]` 或講者標記），因該些標記不適用於單段即時字幕的輸入。

校稿的指示內容 MUST NOT 開放使用者自訂，以維持行為一致與可預期。

#### Scenario: Live caption and batch proofreading correct the same class of errors

- **WHEN** 相同的同音字錯誤分別出現於即時字幕與批次逐字稿
- **THEN** 兩者的校稿 MUST 依循相同的核心修正原則得出一致的校正方向

#### Scenario: Live caption proofreading does not require timestamp or speaker markers

- **WHEN** 即時字幕的單段文字不含時間戳記或講者標記
- **THEN** 校稿 MUST 正常運作，MUST NOT 因缺少該些標記而失敗或產生錯誤格式的輸出

### Requirement: System displays captions in an always-on-top floating window

系統 MUST 以獨立的浮動視窗顯示即時字幕。該視窗 MUST 永遠置於其他視窗之上，MUST 可由使用者移動與調整大小，且 MUST 不出現於工作列的獨立項目干擾主視窗操作。

字幕視窗 MUST 保留最近固定 2 段的字幕，較舊的內容 MUST 隨新字幕產生而捲離，避免無限增長。此段數為固定值，MUST NOT 開放使用者調整，MUST NOT 依視窗當下高度動態增減——換句時前一段字幕 MUST 仍與新一段並存顯示一段時間，使使用者來得及讀完前一段，而非新句一出現前一句就立即消失。

若視窗當下高度不足以完整容納所保留的段數，系統 MUST 將內容貼齊視窗底部並裁切超出頂部可視範圍的部分（較舊的一段可能只露出下半部），MUST NOT 為了避免裁切而在放不下時砍掉本應保留的段數，MUST NOT 讓內容延伸至視窗邊界之外（不得蓋住標題列或溢出視窗本體）。使用者可透過放大視窗或選用較小字級來完整看到兩段內容。

使用者調整字幕視窗大小或變更字級不改變保留段數，僅改變其視覺呈現是否完整可見。

單段字幕的文字長度超過視窗寬度時 MUST 自動換行完整顯示，MUST NOT 截斷或省略內容。

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

#### Scenario: New caption appears while the previous one is still readable

- **WHEN** 新一段字幕產生，且保留段數尚未達上限
- **THEN** 前一段字幕 MUST 與新一段並存顯示，MUST NOT 被新字幕立即取代消失

#### Scenario: Window is too small to fully show the retained captions

- **WHEN** 字幕視窗當下高度不足以完整顯示所保留的固定段數
- **THEN** 系統 MUST 仍保留該段數，將內容貼齊底部並裁切較舊一段超出頂部的部分，MUST NOT 為了避免裁切而砍掉應保留的段落，MUST NOT 讓文字蓋住標題列或溢出視窗本體

#### Scenario: User resizes the caption window

- **WHEN** 使用者於 session 進行中放大字幕視窗
- **THEN** 先前因視窗過小而超出可視範圍的字幕 MUST 變為完整可見，保留段數本身 MUST NOT 因此改變

#### Scenario: A single caption is longer than the window width

- **WHEN** 某段字幕的文字長度超過字幕視窗寬度
- **THEN** 該段字幕 MUST 自動換行完整顯示，MUST NOT 被截斷或以省略號略去內容

### Requirement: Caption font size is chosen from preset sizes

字幕字級 MUST 以預先定義的尺寸選項供使用者選擇，MUST NOT 要求使用者輸入數值。

選項 MUST 涵蓋由小至大的多個級距，使使用者無須理解實際像素值即可選用。

字級不影響保留的固定段數；選擇較大字級而視窗過小時，依「System displays captions in an always-on-top floating window」的規定裁切較舊一段超出頂部的部分，而非減少段數。

#### Scenario: User selects a larger font size

- **WHEN** 使用者選擇較大的字級選項
- **THEN** 字幕 MUST 以該字級顯示，保留段數 MUST NOT 因此減少；若視窗過小以致無法完整顯示，MUST 裁切較舊一段超出頂部的部分，MUST NOT 讓文字溢出視窗

#### Scenario: User is not required to enter a numeric size

- **WHEN** 使用者開啟字幕字級設定
- **THEN** 系統 MUST 呈現可直接選取的尺寸選項，MUST NOT 要求輸入數值

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

此限制適用於**設定項的變更**。字幕視窗大小的調整不屬設定項變更——其僅影響已保留段數的視覺呈現是否完整可見（見浮動視窗的相關需求），不改變保留段數本身，故 MUST 於 session 進行中即時反映，MUST NOT 要求重新啟動。

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

此限制 MUST 涵蓋為診斷目的而暫時輸出的音訊或文字檔。診斷用的輸出 MUST NOT 存在於交付狀態的程式中，MUST NOT 於一般使用時寫入任何檔案。

#### Scenario: Session ends

- **WHEN** 即時字幕 session 結束
- **THEN** 系統 MUST NOT 於資料庫、錄音清單或檔案系統中留下該次字幕的任何記錄

#### Scenario: Live captions run in the delivered build

- **WHEN** 使用者於交付狀態的程式執行即時字幕
- **THEN** 系統 MUST NOT 將擷取到的音訊寫入任何檔案，包含為診斷目的而輸出的音訊檔

### Requirement: Live captions do not provide speaker diarization

即時字幕 MUST NOT 標註語者身分。此限制源於分段轉錄無法維持跨段一致的語者分群結果，標註反而會產生誤導。既有批次逐字稿的語者分離功能 MUST 不受本限制影響。

#### Scenario: Multiple speakers appear in live captions

- **WHEN** 即時字幕擷取的音訊包含多位說話者
- **THEN** 系統 MUST 輸出不含語者標籤的字幕文字

#### Scenario: Batch transcription retains diarization

- **WHEN** 使用者對既有錄音執行批次逐字稿並啟用語者分離
- **THEN** 該流程 MUST 仍依原有行為輸出含語者標籤的逐字稿
