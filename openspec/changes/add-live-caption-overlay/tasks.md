## 1. 建置環境與相依準備

- [x] 1.1 安裝 LLVM（提供 libclang，供 bindgen 使用）與 CMake，確認 `cmake --version` 與 libclang 可被 bindgen 找到
  - 已裝 LLVM 22.1.8、CMake 4.4.1（winget）。LLVM 安裝程式未將 `bin` 加入 PATH，另設使用者環境變數 `LIBCLANG_PATH=C:\Program Files\LLVM\bin`；以獨立 crate 呼叫 `bindgen::clang_version()` 實測可載入 libclang 22.1.8。
- [x] 1.2 安裝 **CUDA Toolkit 12.8 或更新版本**（開發機為 RTX 5060／Blackwell，compute capability `sm_120`，12.8 以前的 toolkit 無法產生對應 kernel）（GPU 加速用，非必要建置條件）
  - 已裝 CUDA Toolkit 13.3（`nvcc` V13.3.73，`CUDA_PATH` 指向 v13.3），高於 12.8 門檻。sm_120 kernel 是否真的產生，仍待任務 1.5 實際載入模型驗證。
- [x] 1.3 以 CLI 於 `src-tauri/Cargo.toml` 加入 `whisper-rs` 0.16（`default-features = false`），並定義專案 feature `live-caption-cuda` 轉開 `whisper-rs/cuda`
  - 以 `cargo add whisper-rs@0.16 --no-default-features` 加入，並於 `Cargo.toml` 新增 `[features] live-caption-cuda = ["whisper-rs/cuda"]`。
- [x] 1.4 執行 `cargo build` 確認預設（CPU）建置可通過
  - `cargo build` 成功（1m19s）。注意：本機 Bash 工具的 shell PATH 未包含新安裝的 CMake（`C:\Program Files\CMake\bin`），需在指令前 `export PATH="$PATH:/c/Program Files/CMake/bin"` 才能讓 `whisper-rs-sys` 的 build script 找到 `cmake`；系統 Machine PATH 實際已含該路徑，僅為舊 shell 未重新載入。
- [ ] 1.5 以 `--features live-caption-cuda` 建置並**實際載入模型在 GPU 上完成一次轉錄**，確認 sm_120 kernel 可用（僅確認 `nvcc --version` 不足以驗證）。若 `whisper-rs-sys` 所綁的 whisper.cpp 未帶入該架構，於建置環境設定 `CMAKE_CUDA_ARCHITECTURES=120`
- [ ] 1.6 下載一個 GGML 模型檔（建議 `small` 或 `medium` 等級）供後續開發實測使用

## 2. 音訊擷取層重構（不改變既有錄音行為）

- [x] 2.1 **麥克風路徑**：將 `downmix_and_resample` 的目標取樣率由模組常數 `TARGET_SAMPLE_RATE` 改為函式參數
  - `downmix_and_resample` 與 `push_resampled_samples` 新增 `target_rate: u32` 參數；`start_microphone_stream` 亦新增同名參數並沿三個 `SampleFormat` 分支的 closure 往下傳。
- [x] 2.2 更新既有錄音的所有呼叫端傳入 48000，確認既有錄音行為完全不變
  - `run_recording_session` 呼叫 `start_microphone_stream` 時傳入 `TARGET_SAMPLE_RATE`（48000），邏輯與數值皆與重構前相同。`cargo build` 通過。
- [x] 2.3 **系統音訊路徑**：將 `start_windows_loopback_capture` 中 `WaveFormat::new`（`audio_recording/mod.rs:617`）所要求的取樣率參數化。此路徑自行降混（`:638`）且不經過 `downmix_and_resample`，遺漏會導致送入模型的取樣率錯誤
  - 新增 `target_rate: u32` 參數，`WaveFormat::new` 改用該參數；呼叫端傳入 `TARGET_SAMPLE_RATE`。
- [x] 2.4 於 `initialize_client` 後查詢 WASAPI 實際生效的格式，確認 16 kHz 請求是否被接受；若裝置回退為混音器格式，則對擷取結果補做軟體重取樣至目標取樣率
  - 以 `audio_client.get_mixformat()?.get_samplespersec()` 取得實際生效取樣率；若與 `target_rate` 不符，對降混後的樣本呼叫既有 `downmix_and_resample(&converted, 1, actual_rate, target_rate)` 補做軟體重取樣，相符時直接使用原始樣本，行為與既有 48kHz 路徑一致（因裝置通常接受 48kHz 請求，此分支對既有錄音為 no-op）。
- [x] 2.5 將 WASAPI loopback 擷取與麥克風 cpal 串流啟動邏輯抽出為可重用單元，使即時字幕與既有錄音共用
  - `select_input_device`、`start_microphone_stream`、`start_windows_loopback_capture`（含 `SelectedInputDevice`、`SharedQueue`、`SharedError`）改為 `pub(crate)`，供未來 `live_caption` 模組以 `crate::audio_recording::...` 直接呼叫，不重複實作擷取邏輯。函式本身已是細粒度、單一用途單元，故未另外包一層抽象。
- [ ] 2.6 手動實測既有桌面錄音（僅麥克風／僅電腦音訊／混音三種模式）確認無回歸

## 3. 即時字幕後端核心

- [ ] 3.1 建立 `src-tauri/src/live_caption/mod.rs`，定義 `LiveCaptionManager`（含單一 session 狀態）與 session 請求／事件的資料結構
- [ ] 3.2 實作 session 啟動：依所選來源啟動音訊擷取（16 kHz f32 mono），並在啟動前檢查是否已有錄音或字幕 session 進行中，若有則拒絕
- [ ] 3.2a 於既有錄音的啟動路徑（`start_recording`）加入反向檢查：即時字幕進行中時拒絕開始錄音並回報原因
- [ ] 3.3 實作 session 停止：停止擷取、釋放音訊裝置與模型資源、關閉字幕視窗，確保不留下任何檔案或資料庫記錄
- [ ] 3.4 實作滑動視窗切分：以可設定的視窗長度與步進（預設 5 秒／3 秒）從音訊佇列取出重疊視窗
- [ ] 3.5 實作靜音門檻判定，低於門檻的視窗直接略過不送轉錄
- [ ] 3.6 實作平台檢查：非 Windows 平台選擇「電腦音訊」來源時，於啟動前回報該來源不可用

## 4. 轉錄後端整合

- [ ] 4.1 實作本地 whisper 路徑：session 啟動時以 `WhisperContext` 載入模型一次，對每個視窗呼叫 `WhisperState::full()` 取得文字。轉錄迴圈須跑在專屬 OS 執行緒（`thread::spawn`），不可置於 tokio async runtime——`full()` 為同步阻塞呼叫，會卡住整個 executor
- [ ] 4.2 實作模型載入失敗處理（路徑未設定、檔案不存在、格式不符、記憶體不足），於啟動時回報具體原因並拒絕啟動
- [ ] 4.3 實作自架 ASR 服務路徑：沿用既有 `transcribe_voxnote_asr` 對每個視窗發出轉錄請求
- [ ] 4.4 實作自架服務連線失敗處理，於啟動時回報並拒絕啟動
- [ ] 4.5 實作重疊調解：比對相鄰視窗轉錄結果的尾首重複文字並去除後才輸出
- [ ] 4.6 實作單次轉錄失敗的容錯：略過該段並繼續處理後續音訊，不中止 session

## 5. 字幕翻譯

- [ ] 5.1 以既有 `call_llm()` 實作字幕翻譯，system prompt 指定輸出繁體中文台灣用語
- [ ] 5.2 實作翻譯開關與顯示模式（僅譯文／僅原文／原文加譯文並列）
- [ ] 5.3 實作翻譯失敗容錯：輸出未翻譯的原文並繼續，不中止 session

## 6. 事件推送與 Tauri 命令層

- [ ] 6.1 定義字幕事件 payload（原文、譯文、序號），以 `app.emit` 推送至前端
- [ ] 6.2 建立 `src-tauri/src/commands/live_caption_cmds.rs`，實作啟動、停止、查詢狀態、列出可用音訊來源等 command
- [ ] 6.3 實作音訊裝置失效的處理：結束 session、關閉字幕視窗並向前端回報原因
- [ ] 6.4 於 `src-tauri/src/lib.rs` 註冊 `LiveCaptionManager` state 與所有新增 command

## 7. 設定項

- [ ] 7.1 於 `AppConfig` 新增即時字幕設定欄位（後端選擇、本地模型路徑、音訊來源、視窗長度、步進、靜音門檻、是否翻譯、顯示模式、字級）
- [ ] 7.2 於 `src/types/index.ts` 同步新增對應的 TypeScript 型別欄位
- [ ] 7.3 於 `src/pages/settings.ts` 新增即時字幕設定區塊
- [ ] 7.4 於設定頁顯示目前建置是否含 GPU 加速，並提示雲端 LLM 長時間翻譯的費用累積與 VRAM 共用風險

## 8. 字幕浮動視窗

- [ ] 8.1 於 `tauri.conf.json` 宣告字幕視窗（無邊框、永遠置頂、不顯示於工作列、預設隱藏）
- [ ] 8.2 建立字幕視窗的前端進入點（HTML 與 TS），監聽字幕事件並渲染
- [ ] 8.3 實作僅保留最近 N 段字幕的渲染邏輯，確保長時間執行不會持續累積記憶體
- [ ] 8.4 實作視窗拖曳與調整大小
- [ ] 8.5 實測透明背景在 Windows 的表現，若點擊穿透或陰影異常則退回不透明樣式

## 9. 主視窗控制介面

- [ ] 9.1 建立 `src/api/liveCaption.ts` 封裝所有即時字幕的 invoke 呼叫
- [ ] 9.2 建立 `src/pages/liveCaption.ts` 控制面板（來源選擇、啟停按鈕、狀態顯示）
- [ ] 9.3 於 `src/main.ts` 註冊路由，並於導航列加入入口
- [ ] 9.4 實作錯誤訊息顯示（啟動失敗、session 中斷）

## 10. 實測與調校

- [ ] 10.1 以實際 YouTube 影片實測中文語音的字幕正確性與延遲
- [ ] 10.2 以實際英文影片實測翻譯品質與延遲
- [ ] 10.3 調校視窗長度、步進與靜音門檻的預設值，並記錄實測結果
- [ ] 10.4 實測長時間（30 分鐘以上）執行的記憶體與 VRAM 穩定度
- [ ] 10.5 實測互斥雙向皆生效（錄音中啟動字幕、字幕中啟動錄音）、裝置失效、模型載入失敗等錯誤路徑

## 11. 文件

- [ ] 11.1 於 README 的開發環境章節加入 LLVM、CMake 與（選用）CUDA Toolkit 前置需求，並說明 GPU 建置指令
- [ ] 11.2 於 README 功能特色加入即時字幕說明，明確標註 Windows 限定與不支援語者分離
- [ ] 11.3 於 README 說明 GGML 模型檔的取得方式與建議規格
