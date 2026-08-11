## ADDED Requirements

### Requirement: Live captions can capture audio from a single application

即時字幕 MUST 提供以單一應用程式為目標的音訊來源，使擷取範圍限於該應用程式所輸出的聲音，MUST NOT 收錄其他應用程式同時段輸出的聲音。

擷取指定應用程式時，系統 MUST 一併涵蓋該應用程式的子行程，以支援採多行程架構的應用程式。

此音訊來源的擷取粒度為應用程式，MUST NOT 宣稱可隔離應用程式內部的個別分頁、視窗或播放實例。

#### Scenario: User captures browser audio while other applications play sound

- **WHEN** 使用者選擇以瀏覽器為目標啟動即時字幕，且同時段有其他應用程式輸出聲音
- **THEN** 字幕 MUST 僅反映該瀏覽器輸出的語音，且其他應用程式的聲音 MUST NOT 影響轉錄結果

#### Scenario: Target application uses multiple processes

- **WHEN** 被指定的應用程式以多個行程輸出音訊
- **THEN** 系統 MUST 擷取到該應用程式的音訊，MUST NOT 因音訊由子行程輸出而擷取不到聲音

#### Scenario: Multiple tabs play audio in the same browser

- **WHEN** 使用者以瀏覽器為目標，且該瀏覽器有多個分頁同時輸出聲音
- **THEN** 系統 MUST 擷取該瀏覽器的全部聲音，且介面 MUST NOT 使使用者誤以為可只擷取其中單一分頁

### Requirement: System presents selectable applications without requiring process identifiers

系統 MUST 提供可選取的應用程式清單供使用者挑選，MUST NOT 要求使用者自行查找或輸入行程 ID。

清單 MUST 以使用者可辨識的名稱呈現各應用程式。

當清單中無任何可選應用程式時，系統 MUST 明確告知，MUST NOT 呈現空白清單而無說明。

#### Scenario: User selects a target application

- **WHEN** 使用者開啟音訊來源設定並選擇「指定應用程式」
- **THEN** 系統 MUST 列出可選取的應用程式，且使用者 MUST 能以名稱辨識並選定目標

#### Scenario: No application is available for selection

- **WHEN** 系統偵測不到任何可選取的應用程式
- **THEN** 系統 MUST 告知目前無可選應用程式，MUST NOT 僅呈現空白清單

### Requirement: System reports when the target application is unavailable

當使用者選擇「指定應用程式」來源啟動 session，但未選定目標應用程式或該應用程式已不存在時，系統 MUST 於啟動前拒絕並回報可理解的原因，MUST NOT 於 session 啟動後才靜默地不產生字幕。

被擷取的應用程式於 session 進行中結束時，系統 MUST 結束 session 並向使用者回報原因。

#### Scenario: No target application selected at startup

- **WHEN** 使用者選擇「指定應用程式」來源但未選定目標即啟動即時字幕
- **THEN** 系統 MUST 拒絕啟動並回報尚未選定目標應用程式

#### Scenario: Target application exits during a session

- **WHEN** 被擷取的應用程式於 session 進行中結束
- **THEN** 系統 MUST 結束 session 並回報該應用程式已結束，MUST NOT 持續呈現無新字幕的狀態而不說明原因

### Requirement: Application-scoped capture is rejected on unsupported platforms

以應用程式為目標的音訊擷取僅於支援該機制的作業系統版本可用。於不支援的平台或版本，系統 MUST 於啟動前回報該來源不可用，MUST NOT 於啟動後才失敗。

不支援的平台上，此音訊來源 MUST NOT 影響既有的麥克風與全系統音訊來源的可用性。

#### Scenario: User selects application capture on an unsupported Windows version

- **WHEN** 使用者於低於支援版本的 Windows 選擇「指定應用程式」來源並啟動即時字幕
- **THEN** 系統 MUST 拒絕啟動並回報該來源需要較新的 Windows 版本

#### Scenario: Existing audio sources remain available

- **WHEN** 目前平台不支援以應用程式為目標的擷取
- **THEN** 麥克風與全系統電腦音訊來源 MUST 維持可用
