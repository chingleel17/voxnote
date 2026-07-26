## Requirements

### Requirement: User can choose recording source mode before recording starts
錄音頁 MUST 在開始錄音前提供「僅麥克風」、「僅電腦音訊」與「麥克風 + 電腦音訊混音」三種模式，並保留最近一次成功使用的模式與裝置選擇。

#### Scenario: Page opens with the previous successful source configuration
- **WHEN** 使用者再次進入錄音頁，且先前已有成功完成的桌面錄音設定
- **THEN** 系統 MUST 預先帶入上次成功的錄音模式、麥克風裝置與系統音訊裝置選擇

#### Scenario: Mixed mode exposes both microphone and system-audio selectors
- **WHEN** 使用者切換到「麥克風 + 電腦音訊混音」模式
- **THEN** 系統 MUST 顯示可選擇的麥克風裝置與系統音訊來源，並在開始錄音前完成可用性檢查

### Requirement: System validates source availability before starting a desktop recording
當使用者選擇需要桌面音訊的錄音模式時，系統 MUST 在開始錄音前驗證所需來源是否可用，且在不支援或來源缺失時提供可執行的錯誤訊息。

#### Scenario: Selected source is unavailable
- **WHEN** 使用者選擇的麥克風或系統音訊來源不存在、被拔除或不支援 loopback
- **THEN** 系統 MUST 阻止錄音開始，並顯示指出缺少哪個來源與下一步建議的訊息

#### Scenario: Platform does not support system-audio capture
- **WHEN** 使用者在目前平台上選擇「僅電腦音訊」或「混音」模式，但該平台尚未提供實作
- **THEN** 系統 MUST 顯示此模式尚未支援的平台說明，且不得進入錄音中狀態
