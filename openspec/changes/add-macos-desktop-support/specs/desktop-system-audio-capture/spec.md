## ADDED Requirements

### Requirement: System can capture macOS playback audio without a virtual audio driver

在 macOS 13+，系統 MUST 支援全系統播放音訊錄音，無須使用者安裝虛擬音訊驅動或變更音訊路由。擷取 MUST 排除 VoxNote 本身播放聲音，且 MUST NOT 保存螢幕影像。受內容保護限制而無法擷取的內容不在保證範圍。

#### Scenario: User records playback while wearing headphones
- **WHEN** 使用者在 Mac 配戴耳機、播放未受保護的語音內容，並啟動僅電腦音訊錄音
- **THEN** 停止後的預覽 MUST 包含該語音，MUST NOT 依賴麥克風聽到喇叭聲音

#### Scenario: VoxNote plays its own recording preview
- **WHEN** VoxNote 播放音訊預覽且系統擷取進行中
- **THEN** 系統擷取 MUST 排除 VoxNote 自身聲音，避免重複收音

#### Scenario: Capture requires a display but no display is available
- **WHEN** Mac 系統音訊後端無法取得可用擷取來源
- **THEN** 系統 MUST 明確回報來源不可用，MUST NOT 假裝成功並持續輸出空白錄音

## MODIFIED Requirements

### Requirement: System can mix microphone and local system audio into a single recording

當使用者在支援的 Windows 或 macOS 13+ 選擇混音模式時，系統 MUST 同步擷取指定麥克風與本地系統音訊，並輸出單一錄音檔供現有逐字稿與摘要流程使用。來源格式不同時 MUST 維持正常語速、時間與雙來源可辨識性；不得無限累積佇列或靜默丟失其中一路。

#### Scenario: User wears headphones during an online meeting
- **WHEN** 使用者配戴耳機參與線上會議，並以混音模式錄音
- **THEN** 輸出的錄音檔 MUST 同時包含使用者麥克風聲音與來自電腦播放裝置的會議聲音

#### Scenario: Sources use different sample rates
- **WHEN** Mac 麥克風與系統來源使用不同取樣率或回呼時間
- **THEN** 30 分鐘錄音 MUST 保持兩路可辨識、無累積性錯速，並於開頭與結尾的測試同步標記維持 200 毫秒以內差異

#### Scenario: One source stops producing data unexpectedly
- **WHEN** 混音的其中一路來源發生錯誤或失效
- **THEN** 系統 MUST 結束 session 並回報中斷，保留可恢復的已錄內容，MUST NOT 繼續宣稱雙來源混音成功
