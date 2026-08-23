## ADDED Requirements

### Requirement: System generates timed subtitles from a YouTube video before playback

系統 MUST 接受可存取的單一 YouTube 影片連結，並於播放前完成音訊擷取與轉錄，產生涵蓋完整影片的分段時間軸字幕。處理 MUST NOT 依賴影片同時播放。

系統 MUST 回報可辨識的處理階段。重新開啟已完成項目時 MUST 使用已儲存結果，MUST NOT 自動重新轉錄。

#### Scenario: User processes a YouTube video

- **WHEN** 使用者提交可存取的非直播 YouTube 影片
- **THEN** 系統 MUST 取得音訊、完成轉錄並儲存完整字幕時間軸

#### Scenario: Processing reports progress

- **WHEN** 影片字幕正在處理
- **THEN** 系統 MUST 顯示目前階段，包含取得音訊、轉錄與完成，MUST NOT 僅顯示無資訊的等待狀態

#### Scenario: User reopens a processed video

- **WHEN** 使用者重新開啟已完成處理的影片項目
- **THEN** 系統 MUST 使用已儲存的逐字稿與字幕時間軸，MUST NOT 再次擷取或轉錄

### Requirement: Supported sources are limited to non-live YouTube videos

系統 MUST 僅接受能識別為單一影片的 YouTube URL。系統 MUST 於音訊擷取前拒絕非 YouTube URL、進行中的直播及預定直播，並回報可理解原因。

播放清單 URL 若含明確影片 ID，系統 MAY 僅處理該影片，但 MUST NOT 自動處理整份播放清單。

#### Scenario: User submits a non-YouTube URL

- **WHEN** 使用者提交其他影片平台或一般網頁 URL
- **THEN** 系統 MUST 於擷取前拒絕，並告知目前僅支援 YouTube

#### Scenario: User submits a live stream

- **WHEN** 使用者提交進行中或預定直播的 YouTube URL
- **THEN** 系統 MUST 於擷取前拒絕，並告知直播應使用既有即時字幕功能

#### Scenario: User submits a playlist URL with a selected video

- **WHEN** 播放清單 URL 同時包含明確的單一影片 ID
- **THEN** 系統 MAY 處理該單一影片，但 MUST NOT 建立播放清單批次任務

### Requirement: System extracts only audio for transcription

系統 MUST 僅取得轉錄所需的音訊與必要中繼資料，MUST NOT 下載或保存影片視訊內容。暫存音訊 MUST 於處理成功、失敗或取消後清除。

#### Scenario: Audio is prepared for transcription

- **WHEN** 系統處理一支受支援影片
- **THEN** 系統 MUST 取得其音訊用於轉錄，且 MUST NOT 保存視訊內容

#### Scenario: Processing terminates

- **WHEN** 處理成功、失敗或被取消
- **THEN** 系統 MUST 清除該次處理建立的暫存音訊

#### Scenario: Source cannot be accessed

- **WHEN** 影片無效、私人、需要登入、受地區限制或音訊無法取得
- **THEN** 系統 MUST 回報可理解的失敗原因，MUST NOT 建立空白完成項目

### Requirement: Subtitle timing comes from the transcription backend

字幕時間軸 MUST 使用轉錄後端提供的分段 `start` 與 `end`。系統 MUST NOT 以文字長度、字數比例或假設語速推算時間並冒充後端時間。

字幕精度為分段級，介面 MUST NOT 宣稱逐字級對齊。時間缺漏或無效的分段 MUST 以可辨識方式處理。

#### Scenario: Backend provides valid segment times

- **WHEN** 後端回報某段字幕的有效起訖時間
- **THEN** 系統 MUST 以該區間作為字幕顯示時間

#### Scenario: Segment timing is incomplete

- **WHEN** 某段缺少有效起始或結束時間
- **THEN** 系統 MUST 將其視為時間不完整，MUST NOT 自行推算並冒充實際時間

### Requirement: System plays processed videos in a separate embedded player window

系統 MUST 以 VoxNote 的獨立視窗播放已處理影片。該視窗 MUST 載入本地應用程式頁面並使用 YouTube 官方內嵌播放器，MUST NOT 將完整 YouTube 網站直接作為具應用程式權限的 WebView 頁面。

播放器視窗 MUST 與主視窗具有獨立生命週期。關閉播放器 MUST NOT 刪除已儲存影片項目或終止無關的應用程式功能。

#### Scenario: User opens a processed video

- **WHEN** 使用者要求播放已完成處理的影片
- **THEN** 系統 MUST 開啟或聚焦 VoxNote 獨立播放視窗，並於其中載入對應 YouTube 影片

#### Scenario: User closes the player window

- **WHEN** 使用者關閉獨立播放視窗
- **THEN** 系統 MUST 停止該視窗的播放並清理相關資源，但 MUST 保留已儲存影片項目

### Requirement: Subtitles synchronize to the embedded player's media time

字幕 MUST 直接依 YouTube 播放器回報的實際媒體時間顯示，MUST NOT 使用獨立本機計時器推進，也 MUST NOT 要求使用者手動對齊。

暫停、緩衝、跳轉與播放速度改變後，字幕 MUST 依新的播放器媒體時間維持同步。

#### Scenario: Video plays normally

- **WHEN** 播放器時間位於某段字幕的起訖區間
- **THEN** 系統 MUST 顯示該段字幕

#### Scenario: Playback pauses or buffers

- **WHEN** 影片暫停或進入緩衝且媒體時間停止前進
- **THEN** 字幕 MUST NOT 依牆鐘時間自行前進

#### Scenario: User seeks to another position

- **WHEN** 使用者跳轉到不同播放位置
- **THEN** 系統 MUST 依跳轉後的媒體時間更新字幕，MUST NOT 要求重新對齊

#### Scenario: Playback rate changes

- **WHEN** 使用者改變影片播放速度
- **THEN** 字幕 MUST 持續依播放器媒體時間同步，MUST NOT 以固定 1x 時鐘推進

### Requirement: Embedded playback failures provide a non-synchronized browser fallback

影片禁止嵌入、已移除、設為私人或播放器載入失敗時，系統 MUST 顯示可理解的原因，並 MUST 提供以系統預設瀏覽器開啟原始 YouTube URL 的操作。

外部瀏覽器模式 MUST 明確標示不提供 VoxNote 字幕同步。系統 MUST NOT 提供手動對齊、浮動字幕、瀏覽器選擇器或外部播放器控制作為退回方案。

#### Scenario: Video owner disables embedding

- **WHEN** YouTube 播放器回報影片禁止內嵌
- **THEN** 系統 MUST 告知無法在 VoxNote 播放，並提供以預設瀏覽器開啟原始影片的操作

#### Scenario: User opens the source in a browser

- **WHEN** 使用者選擇以預設瀏覽器開啟原始影片
- **THEN** 系統 MUST 開啟原始 URL，並 MUST 告知該播放方式沒有 VoxNote 同步字幕

### Requirement: Player remote content has least privilege

播放視窗與其遠端 YouTube iframe MUST 僅具播放所需的最小權限。遠端內容 MUST NOT 取得檔案系統、shell、資料庫或其他非播放必要的 Tauri 能力。

#### Scenario: YouTube content runs in the player window

- **WHEN** 播放視窗載入 YouTube iframe
- **THEN** 該遠端內容 MUST NOT 能呼叫 VoxNote 的敏感 Tauri commands 或存取本機檔案

### Requirement: Processed videos are persisted separately from meetings

系統 MUST 儲存影片來源、YouTube 影片 ID、標題、逐字稿與字幕時間軸。影片項目 MUST 與會議記錄分屬不同實體，MUST NOT 出現在會議清單，也 MUST NOT 要求與會人員或提供語者分離。

使用者 MUST 能刪除影片項目；刪除後相關逐字稿、字幕與摘要 MUST 一併移除。

#### Scenario: User views meeting records

- **WHEN** 使用者檢視會議記錄清單
- **THEN** 影片字幕項目 MUST NOT 出現在該清單

#### Scenario: User deletes a video item

- **WHEN** 使用者刪除影片項目
- **THEN** 系統 MUST 移除其逐字稿、字幕時間軸與摘要

### Requirement: System can summarize a processed video transcript

系統 MUST 允許使用者主動要求對已處理影片逐字稿產生摘要，並保存於該影片項目。字幕處理完成時 MUST NOT 自動產生摘要。

#### Scenario: User requests a summary

- **WHEN** 使用者對已完成影片項目要求產生摘要
- **THEN** 系統 MUST 重用既有摘要能力產生並儲存摘要

#### Scenario: Processing completes without a summary request

- **WHEN** 影片字幕處理完成但使用者未要求摘要
- **THEN** 系統 MUST NOT 自動呼叫 LLM 產生摘要
