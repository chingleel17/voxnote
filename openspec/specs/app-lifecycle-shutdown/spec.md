## Purpose

確保使用者關閉主視窗時，應用程式的所有背景任務與視窗皆完成收尾並讓進程完全終止，避免安裝、更新或系統資源管理因殘留進程而異常。

## Requirements

### Requirement: System terminates the process when the main window is closed

使用者關閉主視窗時，系統 MUST 攔截關閉事件並執行收尾流程，收尾完成後 MUST 強制終止應用程式進程；不得讓進程在所有可見視窗關閉後仍殘留於背景。

#### Scenario: User closes the main window with no background task running

- **WHEN** 使用者關閉主視窗，且沒有即時字幕 session 或桌面錄音進行中
- **THEN** 系統 MUST 立即終止應用程式進程，不遺留任何背景執行緒或隱藏視窗

#### Scenario: User closes the main window while live caption is running

- **WHEN** 使用者關閉主視窗，且即時字幕 session 進行中
- **THEN** 系統 MUST 先停止即時字幕的音訊擷取與背景執行緒、關閉字幕浮動視窗，再終止應用程式進程

#### Scenario: User closes the main window while a recording is in progress

- **WHEN** 使用者關閉主視窗，且桌面錄音進行中
- **THEN** 系統 MUST 先停止錄音並確保已擷取的錄音資料落盤保存，再終止應用程式進程；不得因強制關閉而遺失已錄製內容

### Requirement: Hidden windows do not prevent process exit

系統內部使用的隱藏視窗（例如即時字幕浮動視窗）MUST 不會在應用程式收尾流程中，阻止 Tauri 判定所有視窗已關閉。

#### Scenario: Live caption overlay was shown earlier in the session

- **WHEN** 使用者曾啟動並停止過即時字幕（浮動視窗曾顯示後被隱藏），之後使用者關閉主視窗
- **THEN** 系統 MUST 在收尾流程中明確關閉該隱藏視窗，應用程式進程 MUST 正常終止
