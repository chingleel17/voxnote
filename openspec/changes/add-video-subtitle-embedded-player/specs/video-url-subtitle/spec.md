## ADDED Requirements

### Requirement: System plays the video with synchronized subtitles in an embedded player

系統 MUST 提供於應用程式內嵌播放影片並自動同步字幕的模式。此模式下，字幕 MUST 依播放器的實際播放進度顯示，MUST NOT 要求使用者手動對齊。

使用者跳轉播放位置時，字幕 MUST 隨之跳至對應時點。

當影片因平台限制無法於應用程式內嵌播放時，系統 MUST 明確告知，並 MUST 保留浮動字幕視窗模式作為替代。

#### Scenario: User plays the video inside the application

- **WHEN** 使用者於應用程式內播放已產生字幕的影片
- **THEN** 字幕 MUST 依播放進度自動顯示對應時點的內容，MUST NOT 要求手動對齊

#### Scenario: User seeks to a different position

- **WHEN** 使用者將播放進度跳轉至影片的其他時點
- **THEN** 字幕 MUST 立即顯示該時點對應的內容

#### Scenario: Embedded playback is unavailable

- **WHEN** 影片因平台限制無法於應用程式內嵌播放
- **THEN** 系統 MUST 告知無法內嵌播放的原因，且浮動字幕視窗模式 MUST 仍可使用
