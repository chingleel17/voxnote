## Requirements

### Requirement: System can capture Windows local system audio as a recording source
在支援的 Windows 環境中，系統 MUST 透過桌面音訊擷取管線擷取目前播放中的本地音訊，並產出可供預覽與後續儲存的錄音結果。

#### Scenario: User records system audio only
- **WHEN** 使用者選擇「僅電腦音訊」模式並開始錄音，且預設輸出裝置正在播放聲音
- **THEN** 系統 MUST 建立可停止的桌面錄音 session，並在停止後提供包含系統播放聲音的暫存錄音檔供預覽

### Requirement: System can mix microphone and local system audio into a single recording
當使用者選擇混音模式時，系統 MUST 同步擷取指定麥克風與 Windows 本地音訊，並輸出單一錄音檔供現有逐字稿與摘要流程使用。

#### Scenario: User wears headphones during an online meeting
- **WHEN** 使用者配戴耳機參與線上會議，並以混音模式錄音
- **THEN** 輸出的錄音檔 MUST 同時包含使用者麥克風聲音與來自電腦播放裝置的會議聲音

### Requirement: System preserves recoverable audio when a desktop recording is interrupted
桌面錄音 session 在發生裝置變更、串流錯誤或使用者手動停止時，系統 MUST 盡可能保留已成功寫入的音訊內容，並回報錄音結果狀態。

#### Scenario: Recording is interrupted by device loss
- **WHEN** 錄音進行中，所選麥克風或系統輸出裝置失效
- **THEN** 系統 MUST 停止 session、保留可恢復的暫存錄音內容，並向前端回傳可顯示給使用者的錯誤原因
