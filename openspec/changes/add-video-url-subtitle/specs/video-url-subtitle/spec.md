## ADDED Requirements

### Requirement: System generates subtitles from a video URL before playback

系統 MUST 接受使用者貼上的影片連結，並於使用者開始觀看之前完成音訊擷取與轉錄，產生帶時間軸的完整字幕。

處理 MUST NOT 要求使用者於處理期間播放該影片；字幕的產生 MUST NOT 依賴當下的音訊播放。

系統 MUST 於處理期間回報進度，使使用者可得知目前所處階段與是否仍在進行。

#### Scenario: User pastes a video URL

- **WHEN** 使用者貼上一個可存取的影片連結並要求產生字幕
- **THEN** 系統 MUST 擷取該影片的音訊、完成轉錄，並產生涵蓋整支影片的帶時間軸字幕

#### Scenario: Processing reports progress

- **WHEN** 影片字幕的處理正在進行
- **THEN** 系統 MUST 回報目前階段（例如取得音訊、轉錄中、完成），MUST NOT 僅呈現無資訊的等待狀態

#### Scenario: Video URL cannot be accessed

- **WHEN** 使用者提供的連結無效、影片不存在、需要登入或受地區限制而無法取得音訊
- **THEN** 系統 MUST 回報可理解的失敗原因，MUST NOT 產生空白字幕或靜默結束

#### Scenario: Playback is not required during processing

- **WHEN** 使用者於處理期間未播放該影片
- **THEN** 字幕 MUST 仍能完整產生，MUST NOT 因未播放而缺漏內容

### Requirement: System extracts only the audio track from the video source

系統 MUST 僅擷取影片的音訊用於轉錄，MUST NOT 保留影片的視訊內容。

音訊擷取所產生的暫存檔 MUST 於處理完成後清除，MUST NOT 無限累積於使用者的檔案系統。

#### Scenario: Audio is extracted for transcription

- **WHEN** 系統處理一支影片連結
- **THEN** 系統 MUST 取得該影片的音訊用於轉錄，MUST NOT 於本機留存影片的視訊內容

#### Scenario: Temporary audio is cleaned up

- **WHEN** 影片字幕處理完成或失敗
- **THEN** 處理期間產生的暫存音訊檔 MUST 被清除

### Requirement: Subtitle timing comes from the transcription backend

字幕的時間軸 MUST 取自轉錄後端所回報的分段時間，MUST NOT 以文字長度、字數比例或語速假設推算。

每段字幕 MUST 具備起始時間與結束時間。當後端未提供某段的結束時間時，系統 MUST 以可辨識的方式處理該段（例如標示為時間不完整），MUST NOT 以推算值冒充後端所提供的實際時間。

時間軸的粒度為分段級。系統 MUST NOT 宣稱提供逐字級的時間對齊。

#### Scenario: Backend provides segment start and end times

- **WHEN** 轉錄後端回報各分段的起始與結束時間
- **THEN** 系統 MUST 以該時間作為字幕的顯示區間

#### Scenario: Backend omits an end time

- **WHEN** 轉錄後端未提供某段的結束時間
- **THEN** 系統 MUST NOT 以字數比例推算後冒充實際時間，MUST 以可辨識的方式處理該段

#### Scenario: Timing granularity is not overstated

- **WHEN** 使用者檢視字幕的時間資訊
- **THEN** 介面 MUST NOT 使使用者誤以為字幕具備逐字級的時間對齊

### Requirement: Live video streams are not supported

本能力 MUST 僅適用於音訊已完整存在的影片。系統 MUST 於使用者提供直播連結時明確告知不支援，MUST NOT 嘗試處理後才失敗。

此限制 MUST NOT 影響既有即時字幕功能——需要處理當下聲音的情境由即時字幕負責。

#### Scenario: User pastes a live stream URL

- **WHEN** 使用者提供的連結為進行中的直播
- **THEN** 系統 MUST 於處理前告知本功能不支援直播，並 MUST 指出即時字幕為該情境的替代方式

#### Scenario: Live captions remain available

- **WHEN** 使用者需要為直播內容取得字幕
- **THEN** 既有的即時字幕功能 MUST 維持可用，MUST NOT 因本能力的限制而受影響

### Requirement: Generated subtitles are displayed in a floating caption window

系統 MUST 提供以浮動字幕視窗呈現已產生字幕的模式，使使用者可於任意播放器（含瀏覽器）觀看影片時疊放字幕。

此模式下，字幕 MUST 依已產生的時間軸推進，而非依當下擷取的音訊。使用者 MUST 能夠指定字幕時間軸與影片播放進度的對齊起點，並 MUST 能於觀看期間暫停與繼續字幕的推進。

字幕視窗的呈現行為（置頂、可移動、可調整大小、點擊穿透、字級選項）MUST 與既有即時字幕的浮動視窗一致，避免使用者需適應兩套不同的操作方式。

#### Scenario: User overlays generated subtitles on an external player

- **WHEN** 使用者於瀏覽器播放影片並啟動已產生字幕的浮動視窗模式
- **THEN** 字幕視窗 MUST 置於播放器之上，並依時間軸依序顯示對應時點的字幕

#### Scenario: User aligns the subtitle timeline with playback

- **WHEN** 使用者於影片播放至特定時點時要求對齊
- **THEN** 系統 MUST 以該時點為基準推進字幕時間軸

#### Scenario: User pauses the video

- **WHEN** 使用者暫停影片播放
- **THEN** 使用者 MUST 能夠暫停字幕推進，使其恢復播放時仍維持對齊

#### Scenario: Caption window behaves consistently with live captions

- **WHEN** 使用者使用已產生字幕的浮動視窗
- **THEN** 其置頂、移動、調整大小、點擊穿透與字級選擇的行為 MUST 與即時字幕的字幕視窗一致

### Requirement: Video subtitle display and live captions are mutually exclusive

影片字幕的浮動視窗與即時字幕共用同一個字幕視窗實體，故同一時間 MUST 僅允許其中一者使用該視窗。

即時字幕 session 進行中時，系統 MUST 拒絕啟動影片字幕的浮動視窗顯示，並回報即時字幕進行中，進行中的即時字幕 session MUST 不受影響。

影片字幕的浮動視窗顯示進行中時，系統 MUST 拒絕啟動即時字幕，並回報影片字幕顯示中，進行中的字幕顯示 MUST 不受影響。

此互斥 MUST 僅適用於**字幕視窗的顯示**。影片的音訊擷取與轉錄處理不佔用字幕視窗，故 MUST 可與即時字幕 session 並行。

#### Scenario: User starts video subtitle display while live captions are active

- **WHEN** 即時字幕 session 進行中，使用者嘗試啟動影片字幕的浮動視窗顯示
- **THEN** 系統 MUST 拒絕啟動並回報即時字幕進行中，進行中的即時字幕 session MUST 不受影響

#### Scenario: User starts live captions while video subtitle display is active

- **WHEN** 影片字幕的浮動視窗顯示進行中，使用者嘗試啟動即時字幕
- **THEN** 系統 MUST 拒絕啟動並回報影片字幕顯示中，進行中的影片字幕顯示 MUST 不受影響

#### Scenario: Video processing runs alongside a live caption session

- **WHEN** 使用者於即時字幕 session 進行中要求處理一支影片連結（僅處理，未啟動字幕顯示）
- **THEN** 系統 MUST 允許該處理進行，MUST NOT 因即時字幕進行中而拒絕

### Requirement: Processed videos are persisted separately from meeting records

影片字幕的處理結果 MUST 可儲存，使使用者無須重新處理即可再次檢視。儲存內容 MUST 包含影片來源、逐字稿與字幕時間軸。

已儲存的影片項目 MUST 與會議記錄分屬不同的實體類型，MUST NOT 出現於會議記錄清單中。

影片項目 MUST NOT 要求與會人員資訊，MUST NOT 提供語者分離——影片內容不具備會議的與會人員語意。

使用者 MUST 能夠刪除已儲存的影片項目。

#### Scenario: User revisits a processed video

- **WHEN** 使用者開啟先前已處理過的影片項目
- **THEN** 系統 MUST 呈現已儲存的逐字稿與字幕，MUST NOT 重新執行轉錄

#### Scenario: Video items do not appear among meetings

- **WHEN** 使用者檢視會議記錄清單
- **THEN** 影片字幕項目 MUST NOT 出現於該清單中

#### Scenario: Video items do not offer diarization

- **WHEN** 使用者檢視某個影片字幕項目
- **THEN** 系統 MUST NOT 提供語者分離選項，MUST NOT 要求填寫與會人員

#### Scenario: User deletes a video item

- **WHEN** 使用者刪除某個影片字幕項目
- **THEN** 該項目的逐字稿與字幕 MUST 被移除

### Requirement: System can summarize a processed video transcript

系統 MUST 允許使用者對已處理影片的逐字稿產生摘要，沿用既有的摘要能力。

摘要 MUST 為選用功能，MUST NOT 於字幕產生時自動執行。

#### Scenario: User requests a summary for a video

- **WHEN** 使用者對已完成轉錄的影片項目要求產生摘要
- **THEN** 系統 MUST 依其逐字稿產生摘要並儲存於該影片項目

#### Scenario: Summary is not generated automatically

- **WHEN** 影片字幕處理完成
- **THEN** 系統 MUST NOT 自動產生摘要，MUST 由使用者主動要求
