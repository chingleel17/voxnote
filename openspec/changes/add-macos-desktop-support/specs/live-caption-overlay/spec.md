## MODIFIED Requirements

### Requirement: System captures audio from the user-selected source

系統 MUST 支援以電腦系統音訊或麥克風作為即時字幕的音訊來源，包括 macOS 13+ 的全系統音訊與指定麥克風。在不支援系統音訊擷取的平台上，系統 MUST 明確告知該來源不可用，而非靜默失敗或產生空白字幕。授權未完成或來源啟動失敗時 MUST 不進入運行狀態，且 MUST NOT 自動切換其他來源。

#### Scenario: User captures computer playback audio
- **WHEN** 使用者於支援的平台選擇「電腦音訊」來源並啟動即時字幕，且電腦正在播放含語音的內容
- **THEN** 系統 MUST 依據該播放內容產生字幕

#### Scenario: System audio is unavailable on the platform
- **WHEN** 使用者在不支援系統音訊擷取的平台選擇「電腦音訊」來源
- **THEN** 系統 MUST 在啟動前告知該來源於目前平台不可用，並不啟動 session

#### Scenario: macOS user enables captions for headphone playback
- **WHEN** Mac 使用者配戴耳機播放未受保護的語音內容，選擇全系統音訊並完成授權
- **THEN** 系統 MUST 產生對應字幕並顯示浮動視窗，MUST NOT 依賴麥克風收音或建立持久化錄音檔

#### Scenario: macOS user selects a microphone
- **WHEN** Mac 使用者選擇指定麥克風啟動字幕並完成必要授權
- **THEN** 系統 MUST 使用該麥克風，支援已設定的本地或遠端轉錄後端，且停止後釋放音訊資源

#### Scenario: macOS system permission is denied
- **WHEN** Mac 使用者拒絕全系統音訊擷取的必要權限
- **THEN** 系統 MUST 保持非運行狀態並提示授權方式，MUST NOT 偷改為麥克風或持續顯示空白字幕
