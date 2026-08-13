## MODIFIED Requirements

### Requirement: System produces captions incrementally from a continuous audio stream

系統 MUST 將持續的音訊串流切分為時間視窗並逐段轉錄，使字幕在聆聽過程中陸續出現，而非等待音訊結束。相鄰視窗之間 MUST 有重疊，以降低邊界處語句被切斷造成的漏字。

增量模式啟用時，系統 MUST NOT 以「視窗填滿」作為輸出字幕的前提；字幕的輸出時機改由 `streaming-caption-decoding` 的一致性判定決定，使延遲不受視窗長度限制。增量模式關閉時，系統 MUST 以完整視窗為單位輸出字幕。

系統 MUST 略過音量低於靜音門檻的視窗，不對其發出轉錄請求。

#### Scenario: Captions appear while audio is still playing

- **WHEN** 使用者啟動即時字幕且音訊持續播放
- **THEN** 系統 MUST 在音訊尚未結束前即陸續輸出字幕，且每段字幕輸出後 MUST 繼續處理後續音訊

#### Scenario: Audio contains a silent passage

- **WHEN** 音訊進入無語音的靜音片段
- **THEN** 系統 MUST 不對該片段發出轉錄請求，且 MUST 不產生空白或無意義的字幕

#### Scenario: Caption appears before its window has filled

- **WHEN** 增量模式啟用且某段語音所屬的視窗尚未填滿
- **THEN** 系統 MUST 在視窗填滿之前即輸出該語音中已穩定的文字，MUST NOT 等待視窗填滿

### Requirement: System deduplicates overlapping caption results by similarity

相鄰的轉錄視窗因重疊而可能對同一段語音產生內容相同但字面不完全一致的結果。系統 MUST 以相似度比對判定重複，MUST NOT 僅依賴前後綴的精確字串比對。

系統 MUST 對最近數筆已輸出的字幕結果進行比對，而非僅比對前一筆。

系統 MUST 避免對過短的文字誤判為重複。

**適用範圍**：本需求適用於增量模式關閉時的視窗式輸出路徑。增量模式啟用時，重疊內容改由 `streaming-caption-decoding` 的一致性判定處理——該路徑以連續解碼結果的共同部分判定文字是否穩定，本需求的整段相似度比對 MUST NOT 於該路徑重複套用，以免已確定的文字因與先前輸出相似而被誤刪。

#### Scenario: Same speech is recognized slightly differently across windows

- **WHEN** 增量模式關閉，且相鄰視窗對同一段語音產生字面略有差異但內容相同的轉錄結果
- **THEN** 系統 MUST 判定為重複並且 MUST NOT 重複輸出該內容

#### Scenario: Duplicate content matches an earlier result rather than the immediately previous one

- **WHEN** 增量模式關閉，且某段字幕與前數筆（非緊鄰前一筆）已輸出的字幕內容重複
- **THEN** 系統 MUST 判定為重複並且 MUST NOT 重複輸出

#### Scenario: Two short phrases differ only slightly but are genuinely different

- **WHEN** 兩段極短的文字字面相近但實為不同內容
- **THEN** 系統 MUST NOT 將其誤判為重複，兩者 MUST 皆被輸出

#### Scenario: Incremental mode handles overlap without similarity deduplication

- **WHEN** 增量模式啟用，且連續解碼對同一段語音產生重疊的結果
- **THEN** 重疊 MUST 由一致性判定處理，且整段相似度去重 MUST NOT 額外套用於已確定的文字

### Requirement: System displays captions in an always-on-top floating window

系統 MUST 以獨立的浮動視窗顯示即時字幕。該視窗 MUST 永遠置於其他視窗之上，MUST 可由使用者移動與調整大小，且 MUST 不出現於工作列的獨立項目干擾主視窗操作。

字幕視窗 MUST 保留最近固定 2 段的字幕，較舊的內容 MUST 隨新字幕產生而捲離，避免無限增長。此段數為固定值，MUST NOT 開放使用者調整，MUST NOT 依視窗當下高度動態增減——換句時前一段字幕 MUST 仍與新一段並存顯示一段時間，使使用者來得及讀完前一段，而非新句一出現前一句就立即消失。

若視窗當下高度不足以完整容納所保留的段數，系統 MUST 將內容貼齊視窗底部並裁切超出頂部可視範圍的部分（較舊的一段可能只露出下半部），MUST NOT 為了避免裁切而在放不下時砍掉本應保留的段數，MUST NOT 讓內容延伸至視窗邊界之外（不得蓋住標題列或溢出視窗本體）。使用者可透過放大視窗或選用較小字級來完整看到兩段內容。

使用者調整字幕視窗大小或變更字級不改變保留段數，僅改變其視覺呈現是否完整可見。

單段字幕的文字長度超過視窗寬度時 MUST 自動換行完整顯示，MUST NOT 截斷或省略內容。

增量模式啟用時，字幕視窗 MUST 使暫定文字與確定文字在視覺上可被使用者區分。暫定文字被後續解碼修正時，視窗 MUST 就地更新該文字，MUST NOT 將修正後的內容視為新的一段而佔用額外的保留段數。

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

#### Scenario: Tentative text is visually distinguishable from confirmed text

- **WHEN** 增量模式啟用且字幕視窗同時顯示暫定與確定的文字
- **THEN** 兩者 MUST 在視覺上可被使用者區分，使使用者能辨識哪些內容可能仍會變動

#### Scenario: Tentative text is revised in place

- **WHEN** 某段暫定文字被後續解碼修正
- **THEN** 字幕視窗 MUST 就地更新該段文字，MUST NOT 將其視為新的一段而使前一段字幕提前捲離
