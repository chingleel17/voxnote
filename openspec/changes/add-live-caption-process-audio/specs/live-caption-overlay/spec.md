## ADDED Requirements

### Requirement: Live captions can capture audio from a single application

即時字幕 MUST 提供以單一應用程式為目標的音訊來源，使擷取範圍限於該應用程式所輸出的聲音，MUST NOT 收錄其他應用程式同時段輸出的聲音。

擷取指定應用程式時，系統 MUST 一併涵蓋該應用程式的子行程，以支援採多行程架構的應用程式。

此音訊來源的擷取粒度為應用程式，MUST NOT 宣稱可隔離應用程式內部的個別分頁、視窗或播放實例。

此來源 MUST 僅改變音訊擷取範圍，MUST 使用與麥克風及全系統音訊相同的後續字幕處理路徑。增量模式啟用時 MUST 套用 `streaming-caption-decoding` 的增量政策；增量模式關閉時 MUST 維持既有視窗式輸出。

#### Scenario: User captures browser audio while other applications play sound

- **WHEN** 使用者選擇以瀏覽器為目標啟動即時字幕，且同時段有其他應用程式輸出聲音
- **THEN** 字幕 MUST 僅反映該瀏覽器輸出的語音，且其他應用程式的聲音 MUST NOT 影響轉錄結果

#### Scenario: Target application uses multiple processes

- **WHEN** 被指定的應用程式以多個行程輸出音訊
- **THEN** 系統 MUST 擷取到該應用程式的音訊，MUST NOT 因音訊由子行程輸出而擷取不到聲音

#### Scenario: Multiple tabs play audio in the same browser

- **WHEN** 使用者以瀏覽器為目標，且該瀏覽器有多個分頁同時輸出聲音
- **THEN** 系統 MUST 擷取該瀏覽器的全部聲音，且介面 MUST NOT 使使用者誤以為可只擷取其中單一分頁

#### Scenario: Incremental decoding is enabled for application capture

- **WHEN** 使用者以指定應用程式為來源並啟用增量模式
- **THEN** 系統 MUST 將該來源音訊交由共同的增量解碼與一致性判定處理，MUST NOT 建立來源專屬的字幕政策

#### Scenario: Incremental decoding is disabled for application capture

- **WHEN** 使用者以指定應用程式為來源並關閉增量模式
- **THEN** 系統 MUST 將該來源音訊交由既有視窗式路徑處理，MUST NOT 因來源不同而改變輸出規則

### Requirement: System presents selectable applications without requiring process identifiers

系統 MUST 提供可選取的應用程式清單供使用者挑選，MUST NOT 要求使用者自行查找或輸入行程 ID。

清單 MUST 以使用者可辨識的名稱呈現各應用程式。

系統 MUST 將音訊工作階段所屬的子行程解析為可涵蓋該應用程式行程樹的目標，並 MUST 將同一應用程式的重複音訊工作階段合併為單一選項。系統 MUST NOT 讓使用者從無法代表整個應用程式的多個內部行程中猜測目標。

當清單中無任何可選應用程式時，系統 MUST 明確告知，MUST NOT 呈現空白清單而無說明。

#### Scenario: User selects a target application

- **WHEN** 使用者開啟音訊來源設定並選擇「指定應用程式」
- **THEN** 系統 MUST 列出可選取的應用程式，且使用者 MUST 能以名稱辨識並選定目標

#### Scenario: No application is available for selection

- **WHEN** 系統偵測不到任何可選取的應用程式
- **THEN** 系統 MUST 告知目前無可選應用程式，MUST NOT 僅呈現空白清單

#### Scenario: A browser exposes multiple audio processes

- **WHEN** 同一瀏覽器的多個音訊工作階段或子行程同時出現在列舉結果中
- **THEN** 系統 MUST 將其合併為一個可辨識的瀏覽器選項，且選定後 MUST 以可涵蓋其行程樹的目標啟動擷取

### Requirement: System reports when the target application is unavailable

當使用者選擇「指定應用程式」來源啟動 session，但未選定目標應用程式或該應用程式已不存在時，系統 MUST 於啟動前拒絕並回報可理解的原因，MUST NOT 於 session 啟動後才靜默地不產生字幕。

目標行程 ID MUST 僅用於當次 session 啟動，MUST NOT 寫入持久設定。系統 MUST 在開始擷取前確認行程仍存在且仍是使用者所選應用程式，MUST NOT 因 PID 已被其他行程重用而擷取錯誤目標。

被擷取的應用程式於 session 進行中結束時，系統 MUST 結束 session 並向使用者回報原因。

被擷取的應用程式仍在執行但暫時沒有音訊輸出時，系統 MUST 將其視為靜音並維持 session，MUST NOT 誤判為應用程式已結束。

#### Scenario: No target application selected at startup

- **WHEN** 使用者選擇「指定應用程式」來源但未選定目標即啟動即時字幕
- **THEN** 系統 MUST 拒絕啟動並回報尚未選定目標應用程式

#### Scenario: Target application exits during a session

- **WHEN** 被擷取的應用程式於 session 進行中結束
- **THEN** 系統 MUST 結束 session 並回報該應用程式已結束，MUST NOT 持續呈現無新字幕的狀態而不說明原因

#### Scenario: Selected process identifier is stale or reused

- **WHEN** 使用者選取應用程式後才啟動 session，但原行程已結束或該 PID 已屬於其他應用程式
- **THEN** 系統 MUST 拒絕啟動並要求重新整理與重選，MUST NOT 擷取目前持有該 PID 的其他行程

#### Scenario: Target application temporarily stops rendering audio

- **WHEN** 目標應用程式仍在執行但暫時沒有任何音訊 render stream
- **THEN** 系統 MUST 維持 session 並依靜音行為處理，且在目標恢復輸出後 MUST 繼續擷取

### Requirement: Application-scoped capture is rejected on unsupported platforms

以應用程式為目標的音訊擷取僅於 Windows build 20348 以上可用。於不支援的平台或版本，系統 MUST 在介面中標示該來源不可用，並 MUST 於啟動前拒絕，MUST NOT 於啟動後才失敗。

不支援的平台上，此音訊來源 MUST NOT 影響既有的麥克風與全系統音訊來源的可用性。

#### Scenario: User selects application capture on an unsupported Windows version

- **WHEN** 使用者於低於支援版本的 Windows 選擇「指定應用程式」來源並啟動即時字幕
- **THEN** 系統 MUST 拒絕啟動並回報該來源需要較新的 Windows 版本

#### Scenario: Existing audio sources remain available

- **WHEN** 目前平台不支援以應用程式為目標的擷取
- **THEN** 麥克風與全系統電腦音訊來源 MUST 維持可用

### Requirement: Application capture is positioned for real-time content

指定應用程式擷取 MUST 定位為直播、線上會議及其他需邊播放邊辨識的即時內容來源。對可存取的非直播 YouTube 影片，介面 MUST 引導使用者優先採用預先處理的影片字幕能力，以取得完整上下文與依播放器媒體時間同步的字幕。

系統 MUST NOT 阻止使用者對其他瀏覽器內容使用指定應用程式擷取，也 MUST NOT 將即時字幕資料與已處理影片項目互相持久化或共用播放狀態。

#### Scenario: User wants subtitles for an accessible non-live YouTube video

- **WHEN** 使用者在指定應用程式擷取介面尋找已存在 YouTube 影片的字幕方式
- **THEN** 介面 MUST 說明預先處理的影片字幕流程可提供較可靠的完整轉錄與同步，MUST NOT 將瀏覽器即時擷取描述為建議方式

#### Scenario: User captions a live meeting or stream

- **WHEN** 使用者需要對線上會議、直播或無法預先取得完整媒體的內容產生字幕
- **THEN** 系統 MUST 允許使用指定應用程式來源啟動即時字幕
