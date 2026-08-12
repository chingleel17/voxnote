## MODIFIED Requirements

### Requirement: System can start and stop a live caption session

系統 MUST 允許使用者啟動與停止即時字幕 session。session 啟動後，系統 MUST 持續擷取所選音訊來源並產生字幕；停止後 MUST 釋放音訊裝置與相關資源，且不遺留任何持久化資料。

同一時間 MUST 僅允許一個即時字幕 session 存在。

應用程式關閉時，若即時字幕 session 進行中，系統 MUST 比照使用者主動停止的流程停止 session（停止音訊擷取、釋放音訊裝置），且 MUST 明確關閉字幕浮動視窗，不得僅隱藏視窗。

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

#### Scenario: Application is closed while a live caption session is running

- **WHEN** 即時字幕 session 進行中，使用者關閉應用程式主視窗
- **THEN** 系統 MUST 停止音訊擷取與背景執行緒、釋放音訊裝置，並明確關閉（而非僅隱藏）字幕浮動視窗
