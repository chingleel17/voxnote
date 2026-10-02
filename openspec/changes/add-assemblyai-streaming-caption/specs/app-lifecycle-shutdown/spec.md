## MODIFIED Requirements

### Requirement: System terminates the process when the main window is closed

使用者關閉主視窗時，系統 MUST 攔截關閉事件並執行收尾流程，收尾完成後 MUST 強制終止應用程式進程；不得讓進程在所有可見視窗關閉後仍殘留於背景。

即時字幕使用雲端串流時，收尾 MUST 包含停止收音、取消該 session 後處理、明確終止串流連線與關閉字幕視窗。串流的終止回應等待最多 2 秒，全部串流收尾最多 5 秒；服務無回應時 MUST 強制釋放連線，MUST NOT 讓網路或 LLM 請求阻止退出。

#### Scenario: User closes the main window with no background task running
- **WHEN** 使用者關閉主視窗，且沒有即時字幕 session 或桌面錄音進行中
- **THEN** 系統 MUST 立即終止應用程式進程，不遺留任何背景執行緒或隱藏視窗

#### Scenario: User closes the main window while live caption is running
- **WHEN** 使用者關閉主視窗，且即時字幕 session 進行中
- **THEN** 系統 MUST 先停止即時字幕的音訊擷取與背景執行緒、關閉字幕浮動視窗，再終止應用程式進程

#### Scenario: User closes the main window while a recording is in progress
- **WHEN** 使用者關閉主視窗，且桌面錄音進行中
- **THEN** 系統 MUST 先停止錄音並確保已擷取的錄音資料落盤保存，再終止應用程式進程；不得因強制關閉而遺失已錄製內容

#### Scenario: User closes the application during a streaming connection attempt
- **WHEN** AssemblyAI 串流仍在建立連線或等待 Begin，使用者關閉主視窗
- **THEN** 系統 MUST 取消啟動、清理已建立資源並在串流停止期限內完成退出

#### Scenario: Streaming service does not respond during application shutdown
- **WHEN** 主視窗退出時服務端或 LLM 沒有回應
- **THEN** 系統 MUST 不等待無限網路回應，須強制釋放串流、關閉隱藏字幕視窗並終止進程
