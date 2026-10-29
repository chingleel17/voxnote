# Tasks

以下為實作與驗證工作，規劃完成不代表功能已完成。Mac 硬體驗證無法執行時須保留未勾選。

## 1. 平台編譯與原生橋接基礎

- [x] 1.1 將 WASAPI 隔離為 Windows target dependency，Mac 原生依賴限定 macOS；驗證 Windows `cargo check --lib`／`cargo test --lib` 及 Cargo.lock 差異無非預期套件升級。
- [ ] 1.2 新增 macOS Objective-C bridge、C ABI header 與 build.rs 條件編譯／framework 連結，保留 tauri-build；在 Mac 以 arm64、x86_64 各完成 `cargo check --target <target>`，確認非 Mac 不會編譯原生檔案。
- [ ] 1.3 建立 macOS 13+ ScreenCaptureKit spike：取得全系統音訊、排除自身、僅處理 audio callback；在 Mac 驗證耳機播放有 PCM、無來源回報錯誤，且無影像檔寫入，再接正式 session。
- [ ] 1.4 補齊 README 中英文 Mac 開發工具鏈、最低 13.0 與雙架構命令；以固定 Xcode／SDK、CMake/libclang 驗證 bridge 與 Whisper CPU 建置架構一致，不啟用 CUDA。

## 2. 權限與可復原啟動狀態

- [ ] 2.1 新增 macOS 專用 Tauri 設定、Info.plist 麥克風用途及實際必要的 entitlements；核對 SDK 權限契約，以封裝後 `.app/Contents/Info.plist` 及 codesign entitlement 檢查證明設定生效。
- [ ] 2.2 實作依來源進行麥克風／ScreenCaptureKit 權限檢查及主執行緒非同步請求；測試僅麥克風不請求螢幕權限、僅系統音訊不請求麥克風權限，列舉裝置不彈提示。
- [ ] 2.3 讓錄音／字幕 command 等待來源啟動確認才回報成功，混音部分失敗完整清理；用啟動失敗／並行開始／取消測試確認回到 idle 且沒有殘留 callback。
- [ ] 2.4 提供拒絕、撤銷、需要重啟的台灣繁體中文錯誤及系統設定指引；Mac 人工測首次授權、拒絕、重新授權與重啟，不得快取拒絕或偷換來源。

## 3. 擷取 session 與混音

- [ ] 3.1 封裝 Mac capture RAII handle、錯誤回呼與 stop/drain/release；在 Mac 連續開始／停止／取消至少 10 次並測啟動中關閉，確認無 crash、死鎖或使用已釋放 context。
- [ ] 3.2 保留 CPAL 麥克風並串接 timestamp、聲道／取樣率正規化與共用 session 時間軸；以 44.1／48 kHz、單／雙聲道合成輸入測正常語速、時間長度與補零。
- [ ] 3.3 實作 Mac 雙來源對齊、漂移控制、音量限制與每路 2 秒 queue 上限；加入合成漂移、缺包、溢位與截幅回歸測試，確認錯誤會傳至 session 而非無限緩衝。
- [ ] 3.4 接入 desktop recording 的 system／mix 路徑；實機驗證預覽、儲存、取消刪暫存與裝置失效保留可恢復 WAV，並維持 Windows 錄音測試通過。
- [ ] 3.5 Mac 配戴耳機完成 30 分鐘雙來源測試，紀錄開頭／結尾同步標記差異各不超過 200 ms、正常語速及記憶體有界；未通過不得標記混音完成。

## 4. 來源選擇與即時字幕

- [ ] 4.1 Rust models 與 TS types 同步必要的來源／權限資訊，Mac 系統來源使用邏輯 ID `macos-system-audio`，預設麥克風依 ID 比對；驗證序列化、無效舊 ID 與預設來源行為。
- [ ] 4.2 錄音頁呈現 Mac 三模式與「全系統音訊」，移除 Mac 的 Windows-only 提示並提供待授權狀態；`npm run build` 通過且人工確認不顯示 Windows 播放裝置或指定 App 選單。
- [ ] 4.3 字幕 system 接同一 Mac capture 入口、microphone 沿用 CPAL；測本地 Whisper CPU／遠端 ASR、有聲／靜音、停止／中斷，不改變增量字幕政策且不寫音訊／字幕檔。
- [ ] 4.4 依 Tauri 2.11.2 實作 macOS 透明浮窗必要 feature／設定及原生視窗行為；在 Mac 驗證透明、置頂、拖曳縮放、穿透、跨 Spaces／全螢幕及主視窗關閉清理。
- [ ] 4.5 驗證錄音與字幕互斥、錯誤與進度顯示；對照兩個 active caption changes 的來源／解碼接面，Windows system/microphone 與現有增量模式回歸通過。
- [ ] 4.6 README 平台矩陣同步錄音三模式、字幕兩來源、權限用途與 DRM 限制；逐項對照實作畫面與 macOS spec，暫不標示已驗證支援。

## 5. 雙架構候選包與安裝流程

- [ ] 5.1 增加 Mac PR／手動候選建置工作流程，arm64／x86_64 分別編譯測試、建置 `.app`／`.dmg` 並保存 artifacts；核對 Mach-O 架構與最低部署版本，不以正式 release tag 進行試錯。
- [ ] 5.2 使用 ad-hoc identity `-` 完成簽署並驗證 `.app` 完整性；產物名稱與套件版本為 v0.1.5，無 Developer ID 機密設定依賴，Mac CPU 包不混入 Windows CUDA／sidecar。
- [ ] 5.3 在 README 中英文加入未公證說明、架構選擇與 macOS 官方允許開啟流程；從帶下載隔離標記的實際候選包驗證文件，不要求停用 Gatekeeper 或移除 quarantine。
- [ ] 5.4 Mac 從 Applications 啟動測外部 CLI 偵測與不可用錯誤、Unicode 路徑、AppData、設定重啟保存及覆蓋安裝；若 GUI PATH 找不到已安裝工具，補上可驗證的解析方式／設定指引。

## 6. 發布前整合驗收

- [ ] 6.1 在 Apple Silicon 與 Intel 各完成安裝、會議 CRUD、匯入、三模式錄音、預覽儲存、轉錄／摘要、手動編輯、匯出、備份還原及字幕驗收；交付包含 OS／CPU／候選版本／結果的測試紀錄。
- [ ] 6.2 至少在 macOS 13 與一個較新 macOS 測必要授權、撤銷／重啟、耳機系統音訊、混音及浮窗；CI 無音訊裝置通過不得替代這些案例。
- [ ] 6.3 以獨立 OS 帳號或明確隔離的 demo build 建立無個資範例，擷取真實 Mac 主畫面／逐字稿／字幕並更新 README 圖片，確認正式資料未讀取且圖中版本正確。
- [ ] 6.4 全部發布門檻完成後更新 CHANGELOG 與 README，將 macOS 改列已驗證支援；執行 Windows／Mac Rust 測試、前端建置、版本一致性與文件連結檢查，保留未公證限制說明。

## Workflow follow-up

- 目前驗證：Windows `cargo check --offline --locked --lib` 與 `cargo test --offline --locked --lib` 通過（74 項）；Cargo.lock 僅保留先前的 App 版本 0.1.5 更新，無新增套件升級。Mac 原生依賴將在 1.2 加入時限定 macOS。
- 候選建置準備：新增 `.github/workflows/macos-candidate.yml`，使用 `macos-15`（arm64）與 `macos-15-intel`（x86_64）執行測試、打包及簽章／版本／架構檢查；新增 Mac 專用 Tauri 設定與麥克風用途說明。2.1、5.1、5.2 在遠端產物驗證前仍不勾選。
- 實機安排：使用者提供 M 系列 Mac，系統版本自述為 macOS 27.0.1（待實機紀錄確認）。目前工作環境仍是 Windows，原生音訊橋接／spike 尚未實作，Intel 與 macOS 13 實機驗證尚未安排。
- 全部實作與實機驗收完成後再歸檔本 change；依使用者指示提交、建立 PR 與發布 v0.1.5。
- 歸檔前核對 `add-live-caption-process-audio`／`add-streaming-incremental-caption` 的 spec delta，避免互相覆寫來源或浮窗需求。
