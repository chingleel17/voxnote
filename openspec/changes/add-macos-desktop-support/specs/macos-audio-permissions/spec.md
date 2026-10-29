## Purpose

讓 Mac 使用者能理解並控制 VoxNote 對麥克風與系統播放音訊的存取，依功能需求授權，並在權限遭拒絕或撤銷後取得可執行的復原方式，而非誤以為錄音或字幕已正常運作。

## ADDED Requirements

### Requirement: Audio access requests are scoped to the selected source

Mac 版 MUST 附上麥克風用途說明，且僅在使用者啟動需要該來源的錄音或字幕時請求對應權限。僅麥克風 MUST NOT 要求螢幕／系統音訊權限；僅系統音訊 MUST NOT 要求麥克風權限。混音 MUST 確認兩者皆可用才回報啟動成功。

#### Scenario: User starts microphone-only recording
- **WHEN** 使用者首次啟動僅麥克風錄音
- **THEN** 系統 MUST 請求麥克風存取，MUST NOT 因此請求系統畫面擷取存取

#### Scenario: User starts mixed recording
- **WHEN** 使用者啟動混音且任一必要權限未取得
- **THEN** 系統 MUST 完成相應授權流程或回報無法開始，MUST NOT 默默只錄到另一個來源

### Requirement: Permission failures preserve a recoverable idle state

權限遭拒絕或系統要求重新啟動時，系統 MUST 顯示所缺權限及相應系統設定指引，釋放已建立的擷取資源並回到可重試狀態。MUST NOT 自動更換音訊來源或將固定等待時間視為授權完成。

#### Scenario: User denies system capture permission
- **WHEN** 使用者拒絕系統音訊擷取需要的權限
- **THEN** 系統 MUST 不進入錄音／字幕運行狀態，並說明可於系統隱私權設定授權後重試

#### Scenario: Permission becomes available after a restart
- **WHEN** 使用者依系統提示完成授權並重新啟動 App
- **THEN** 系統 MUST 重新檢查權限並允許啟動，MUST NOT 永久快取先前拒絕結果

### Requirement: Capture access is released on interruption and shutdown

權限撤銷、來源失效、停止、取消或關閉 App 時，系統 MUST 結束對應擷取與回呼。中斷的錄音 MUST 依現有復原規則保留可用內容；字幕 MUST 不留下持久化音訊或文字。

#### Scenario: User revokes access during capture
- **WHEN** 使用者在擷取期間撤銷必要權限，且擷取後端回報中斷
- **THEN** 系統 MUST 停止 session 並顯示原因；已成功寫入的錄音可供復原，字幕不得產生診斷音訊檔
