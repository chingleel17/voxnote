## MODIFIED Requirements

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
