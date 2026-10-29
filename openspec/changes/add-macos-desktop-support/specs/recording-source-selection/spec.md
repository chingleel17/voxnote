## ADDED Requirements

### Requirement: macOS source selection represents full-system audio accurately

Mac 錄音頁 MUST 提供僅麥克風、僅電腦音訊與混音；系統來源 MUST 顯示為「全系統音訊」，不得宣稱可選特定應用程式或 Windows 播放裝置。選擇來源時 MUST 不因尚未授權就永久隱藏可支援的模式；啟動前仍須檢查權限與來源。

#### Scenario: User selects mixed recording on macOS
- **WHEN** Mac 使用者切換到混音模式
- **THEN** 系統 MUST 顯示可選麥克風及全系統音訊來源，不要求選擇 Windows 輸出裝置

#### Scenario: Saved device no longer exists
- **WHEN** 上次儲存的裝置識別碼無效或屬於另一平台
- **THEN** 系統 MUST 提示重新選擇或明確使用目前預設來源，MUST NOT 將無效裝置誤標為可用

#### Scenario: Permission has not been granted yet
- **WHEN** Mac 支援系統擷取但尚未取得必要權限
- **THEN** 系統 MUST 顯示可選來源與待授權狀態，並於使用者啟動時進行授權，而非顯示「僅 Windows 支援」
