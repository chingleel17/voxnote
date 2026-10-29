# Design

## Context

動機與範圍見 proposal.md。現有 `audio_recording/mod.rs` 以 CPAL 擷取麥克風、WASAPI 擷取 Windows 系統聲音，`live_caption/mod.rs` 共用麥克風及 loopback。非 Windows 會回報系統音訊不支援；`wasapi` 尚為一般 Cargo 相依。缺少 macOS 隱私用途設定，release workflow 雖列 arm64／x86_64，尚無可用執行紀錄。

使用者已決定 Mac 系統音訊與混音為 v0.1.5 必要功能，並確認尚無 Apple Developer 帳號。目前 Windows 環境可產生規劃與跨平台純邏輯測試，不能取代 Mac SDK 編譯、TCC 權限與實機音訊驗證。

## Goals / Non-Goals

**Goals:**
- 以平台隔離的擷取入口擴充既有錄音／字幕管線，PCM 留在原生／Rust 層，避免前端大資料搬運。
- Windows 行為維持相容，Mac 不依賴虛擬音訊驅動或伺服器專用 GPU。
- 權限、擷取就緒與 session 運行狀態一致，可停止、取消與安全清理。

**Non-Goals:**
- Mac 指定應用程式擷取、影片網址字幕、Metal／CUDA 加速、Universal 安裝包、自動更新與 App Store 上架。
- 在無 Developer ID 憑證下承諾已公證或免安全性提示；不擷取受 DRM 保護的內容。
- 重新設計增量字幕文字穩定化、翻譯政策或資料庫 schema。

## Decisions

### 1. macOS 13+，ScreenCaptureKit 擷取系統音訊

使用 macOS 13 起可用的 ScreenCaptureKit 音訊擷取能力。`SCShareableContent` 選取主顯示器（不可用則第一個可用顯示器），display filter 排除 VoxNote 本身；設定 capturesAudio 與 excludesCurrentProcessAudio。全系統模式擷取跨應用程式的音訊，不將顯示器選擇呈現為聲音輸出裝置。

ScreenCaptureKit 仍可能要求螢幕錄製相關授權；不註冊或保存影像輸出，必要的 stream 影像設定採最小成本且不送至前端。找不到顯示器或擷取來源時明確失敗。不支援 headless 無來源錄音的假成功。

替代方案：Core Audio process taps 要 macOS 14.2+，會縮小系統支援範圍；虛擬裝置需要額外安裝與路由設定。因此不採兩者作為基準。

### 2. 小型 Objective-C 橋接、Rust 管理生命週期

新增 `src-tauri/native/macos/` 的 Objective-C C ABI bridge，透過 target-specific build dependency（例如 `cc`）由 `build.rs` 僅在 macOS 編譯，連結 ScreenCaptureKit、CoreMedia、CoreAudio、AVFoundation 與 Foundation 等實際使用 frameworks。保留現有 tauri-build 呼叫；Windows 不編譯或連結 Mac 原生檔案，WASAPI 移至 Windows target dependency。

Rust `audio_recording/macos` 封裝原生 handle 為 RAII session。原生序列 queue 接收音訊並回呼 Rust，回傳 timestamp、sample rate、channel count 與 PCM；樣本在回呼返回前複製至有上限的 queue，不能保留已失效的 sample buffer 指標。回呼不得執行磁碟、網路或 ASR；不得跨 FFI unwind。停止須等待 stream 停止及回呼 drain，再釋放 callback context，重複停止安全。

使用 CPAL 保留既有麥克風裝置選擇，透過 AVFoundation 查詢／請求麥克風授權；不再平行新增另一套 AVAudioEngine 麥克風實作。原生處理系統音訊，Rust 共用正規化／混音，避免更換 Windows 音訊架構。

### 3. 共用時間軸與有上限音訊緩衝

Mac 系統與 CPAL 麥克風皆轉為目標單聲道浮點 PCM，依各自實際取樣率正規化（錄音沿用 16 kHz，字幕使用現有管線要求）。必須使用來源時間戳映射至 session monotonic clock，不以回呼到達順序直接拼接。

兩路以固定區塊依共同時間軸取樣；短暫缺資料補零，追蹤緩衝／時間差，必要時依量測漂移微調重取樣，避免長時間累積偏移。混音保持既有幅度限制。每路 queue 以 2 秒正規化音訊為上限；錄音持續溢位或來源錯誤時停止並回報可復原結果，字幕則接續既有背壓提示政策。不得以無限 queue 隱藏延遲。

驗收以 30 分鐘雙來源測試，開頭與結尾同步標記差異各不超過 200 ms；沒有變速、一路消失或無界記憶體成長。用合成音訊測試格式、補零、漂移與上限，再以實機補足 CoreAudio／ScreenCaptureKit 行為。

### 4. 權限與啟動狀態是必要流程

在 macOS 專用 Info.plist 加入 `NSMicrophoneUsageDescription`。ScreenCaptureKit 採系統標準螢幕錄製授權檢查／請求及實際啟動錯誤，不把 Core Audio taps 專用的 `NSAudioCaptureUsageDescription` 誤當成 ScreenCaptureKit 的充分授權；額外用途 key 需以 macOS SDK 官方契約確認。

來源列舉不觸發權限請求；使用者按開始後，依所選模式請求需要的權限。權限流程在主執行緒排程，禁止阻塞 UI 等待回呼。混音任一路未就緒即清理另一邊，不允許退化成單一路還顯示成功。若 OS 要求重啟，顯示明確訊息，重新啟動後再讀真實權限。

非同步 command 等待來源啟動確認才回傳成功；內部維持 starting/running/stopping/idle，沿用現有 IPC 命令，前端以 API 封裝顯示開始中或失敗。不得採固定 sleep、忽略錯誤或改選來源作為權限修正。檢查既有 command 是否同步，必要時改 async 以免權限回呼與主執行緒互鎖。

### 5. 平台來源契約與字幕共用

裝置 API 在 Mac 回傳固定邏輯 ID `macos-system-audio`，顯示「全系統音訊」；主顯示器 ID 不持久化。無效舊裝置 ID 提示或明確選用預設，預設麥克風以裝置 ID 而非名稱比較。Rust models 與 TS types 同步新增需要的來源／權限資訊，不把可支援與已授權混為同一布林值。

錄音 system/mix 與字幕 system 呼叫相同 Mac capture 入口；字幕 microphone 仍走 CPAL。字幕不新增 mix 選項（既有字幕來源為 system 或 microphone），但錄音必須支援 mix。Mac 不顯示「僅 Windows 支援」訊息；指定應用程式仍屬另一 change。主視窗關閉沿用既有停止流程，驗證啟動失敗與關閉競速亦能 drain 資源。

### 6. Mac 浮窗與本地模型

固定專案目前 Tauri 2.11.2；該版本透明浮窗需核對並採用 macOS 專用 `macos-private-api` feature 與 `app.macOSPrivateApi` 設定，不以較新 2.12.1 文件推論目前行為。先驗證透明、置頂、拖曳、縮放與穿透；以原生 collection behavior 補足切換 Spaces／全螢幕的既有浮窗需求，不修改字幕段數政策。

Whisper 預設 CPU，兩種架構均須成功編譯 native library，模型使用者自行提供。不納入 Metal 效能承諾。外部 CLI 為選用，Finder 啟動需驗證 PATH；工具缺少時僅回報該選項不可用，不阻斷其他後端。不得以 bundle yt-dlp 作為本 change 相依。

### 7. 獨立 Mac 發行設定與門檻

新增或採用 `tauri.macos.conf.json`，設定 minimumSystemVersion 13.0、Info.plist、必要 entitlements 與 `signingIdentity: "-"`。非 sandbox DMG 分發；僅啟用實際需要的音訊輸入／hardened runtime 權限，不套用大量模板。檢查封裝後 metadata 與 codesign 結果，證明設定有進入 `.app`。

CI 分開 arm64 與 x86_64，核對 runner 架構、Xcode/SDK、部署目標、CMake/libclang 及交叉編譯旗標；原生 bridge 與 Whisper 必須與 Rust target 同架構。用 macOS PR checks 先編譯／測試再手動測候選包；tag 只負責正式發行，不拿正式 tag 試錯。Windows check/test 亦須通過。

使用者無開發者帳號，發行說明明列未公證與系統允許開啟方式，不使用關閉 Gatekeeper 或移除 quarantine 的指令。雙架構 `.app`／`.dmg`、安裝啟動、麥克風／系統／混音／字幕、最低版本與較新 macOS 權限驗證完成後，才能把 README 狀態改為已支援。

## Risks / Trade-offs

- [尚無 Mac 實機／SDK 執行證據] → native bridge 為首個 spike；CI 只能證明編譯，人工音訊／權限／浮窗測試仍是發布門檻。
- [macOS 13 與新版授權 UI 不同] → 測最舊支援版本及較新 macOS，根據真實 OS 錯誤顯示指引，不硬編碼永遠有效的設定頁名稱。
- [ad-hoc 在更新後可能需重新授權或被 Gatekeeper 攔截] → 保持 bundle ID 穩定，測覆蓋更新與重新授權，發行說明揭露限制。
- [系統與麥克風時鐘漂移] → timestamp 正規化、有限緩衝與長測門檻；不得只以 5 秒試錄當成混音完成。
- [與 active caption changes 共用檔案] → 保持後端擷取接面小，合併時重跑 system/microphone 與增量模式；指定應用程式／影片下載不納入本 change。

## Migration Plan

1. 先完成 Mac target 編譯 spike、音訊與權限測試，再接 UI／字幕及打包。
2. 不修改 DB schema、不搬移原有使用者資料，維持既有 bundle ID；Mac 資料放在 Tauri 標準使用者目錄。
3. 使用獨立測試 OS 帳號或明確隔離的 demo build ID 建立示範會議，擷取真實 Mac 主畫面／逐字稿／字幕；不使用使用者既有資料。
4. 建立候選包驗收紀錄（OS、CPU、版本、安裝來源、案例、結果），未通過保持 v0.1.5 待發布。
5. 若 Mac 後端未達門檻，暫緩 Mac 正式發布；保留 Windows 發行能力，不透過降低規格或將未完成任務勾選來宣布成功。

## References

- https://developer.apple.com/documentation/screencapturekit
- https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturesaudio
- https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps
- https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription
- https://v2.tauri.app/distribute/macos-application-bundle/
- https://v2.tauri.app/distribute/sign/macos/
- https://v2.tauri.app/reference/config/#macosprivateapi

文件查核日期：2026-10-29。API 可用性與權限鍵需依實作時固定 SDK／Tauri 版本再次核對；不能以官方支援框架取代本 App 實機驗證。
