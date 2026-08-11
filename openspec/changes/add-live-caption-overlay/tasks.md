## 1. 建置環境與相依準備

- [x] 1.1 安裝 LLVM（提供 libclang，供 bindgen 使用）與 CMake，確認 `cmake --version` 與 libclang 可被 bindgen 找到
  - 已裝 LLVM 22.1.8、CMake 4.4.1（winget）。LLVM 安裝程式未將 `bin` 加入 PATH，另設使用者環境變數 `LIBCLANG_PATH=C:\Program Files\LLVM\bin`；以獨立 crate 呼叫 `bindgen::clang_version()` 實測可載入 libclang 22.1.8。
- [x] 1.2 安裝 **CUDA Toolkit 12.8 或更新版本**（開發機為 RTX 5060／Blackwell，compute capability `sm_120`，12.8 以前的 toolkit 無法產生對應 kernel）（GPU 加速用，非必要建置條件）
  - 已裝 CUDA Toolkit 13.3（`nvcc` V13.3.73，`CUDA_PATH` 指向 v13.3），高於 12.8 門檻。sm_120 kernel 是否真的產生，仍待任務 1.5 實際載入模型驗證。
- [x] 1.3 以 CLI 於 `src-tauri/Cargo.toml` 加入 `whisper-rs` 0.16（`default-features = false`），並定義專案 feature `live-caption-cuda` 轉開 `whisper-rs/cuda`
  - 以 `cargo add whisper-rs@0.16 --no-default-features` 加入，並於 `Cargo.toml` 新增 `[features] live-caption-cuda = ["whisper-rs/cuda"]`。
- [x] 1.4 執行 `cargo build` 確認預設（CPU）建置可通過
  - `cargo build` 成功（1m19s）。注意：本機 Bash 工具的 shell PATH 未包含新安裝的 CMake（`C:\Program Files\CMake\bin`），需在指令前 `export PATH="$PATH:/c/Program Files/CMake/bin"` 才能讓 `whisper-rs-sys` 的 build script 找到 `cmake`；系統 Machine PATH 實際已含該路徑，僅為舊 shell 未重新載入。
- [x] 1.5 以 `--features live-caption-cuda` 建置並**實際載入模型在 GPU 上完成一次轉錄**，確認 sm_120 kernel 可用（僅確認 `nvcc --version` 不足以驗證）。若 `whisper-rs-sys` 所綁的 whisper.cpp 未帶入該架構，於建置環境設定 `CMAKE_CUDA_ARCHITECTURES=120`
- [x] 1.6 下載一個 GGML 模型檔（建議 `small` 或 `medium` 等級）供後續開發實測使用

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
- [x] 2.6 手動實測既有桌面錄音（僅麥克風／僅電腦音訊／混音三種模式）確認無回歸

## 3. 即時字幕後端核心

- [x] 3.1 建立 `src-tauri/src/live_caption/mod.rs`，定義 `LiveCaptionManager`（含單一 session 狀態）與 session 請求／事件的資料結構
- [x] 3.2 實作 session 啟動：依所選來源啟動音訊擷取（16 kHz f32 mono），並在啟動前檢查是否已有錄音或字幕 session 進行中，若有則拒絕
- [x] 3.2a 於既有錄音的啟動路徑（`start_recording`）加入反向檢查：即時字幕進行中時拒絕開始錄音並回報原因
- [x] 3.3 實作 session 停止：停止擷取、釋放音訊裝置與模型資源、關閉字幕視窗，確保不留下任何檔案或資料庫記錄
- [x] 3.4 實作滑動視窗切分：以可設定的視窗長度與步進（預設 5 秒／3 秒）從音訊佇列取出重疊視窗
- [x] 3.5 實作靜音門檻判定，低於門檻的視窗直接略過不送轉錄
- [x] 3.6 實作平台檢查：非 Windows 平台選擇「電腦音訊」來源時，於啟動前回報該來源不可用

## 4. 轉錄後端整合

- [x] 4.1 實作本地 whisper 路徑：session 啟動時以 `WhisperContext` 載入模型一次，對每個視窗呼叫 `WhisperState::full()` 取得文字。轉錄迴圈須跑在專屬 OS 執行緒（`thread::spawn`），不可置於 tokio async runtime——`full()` 為同步阻塞呼叫，會卡住整個 executor
- [x] 4.2 實作模型載入失敗處理（路徑未設定、檔案不存在、格式不符、記憶體不足），於啟動時回報具體原因並拒絕啟動
- [x] 4.3 實作自架 ASR 服務路徑：沿用既有 `transcribe_voxnote_asr` 對每個視窗發出轉錄請求
- [x] 4.4 實作自架服務連線失敗處理，於啟動時回報並拒絕啟動
- [x] 4.5 實作重疊調解：比對相鄰視窗轉錄結果的尾首重複文字並去除後才輸出
- [x] 4.6 實作單次轉錄失敗的容錯：略過該段並繼續處理後續音訊，不中止 session
- [x] 4.7 實作低信心與幻覺輸出的濾除：以逐段 `no_speech_probability()` 判定（不可依賴
  `set_no_speech_thold`，該參數於 whisper-rs 0.16 所綁的上游版本未實作而不生效），
  並以完整片語比對的中英文幻覺清單作為第二道防線，避免單一常用詞誤刪正常語音
  - 門檻值的調校記錄見任務 10.3。

## 5. 字幕翻譯

- [x] 5.1 以既有 `call_llm()` 實作字幕翻譯，system prompt 指定輸出繁體中文台灣用語
- [x] 5.2 實作翻譯開關與顯示模式（僅譯文／僅原文／原文加譯文並列）
- [x] 5.3 實作翻譯失敗容錯：輸出未翻譯的原文並繼續，不中止 session

## 6. 事件推送與 Tauri 命令層

- [x] 6.1 定義字幕事件 payload（原文、譯文、序號），以 `app.emit` 推送至前端
- [x] 6.2 建立 `src-tauri/src/commands/live_caption_cmds.rs`，實作啟動、停止、查詢狀態、列出可用音訊來源等 command
- [x] 6.3 實作音訊裝置失效的處理：結束 session、關閉字幕視窗並向前端回報原因
- [x] 6.4 於 `src-tauri/src/lib.rs` 註冊 `LiveCaptionManager` state 與所有新增 command

## 7. 設定項

- [x] 7.1 於 `AppConfig` 新增即時字幕設定欄位（後端選擇、本地模型路徑、音訊來源、視窗長度、步進、靜音門檻、是否翻譯、顯示模式、字級）
- [x] 7.2 於 `src/types/index.ts` 同步新增對應的 TypeScript 型別欄位
- [x] 7.3 於 `src/pages/settings.ts` 新增即時字幕設定區塊
- [x] 7.4 於設定頁顯示目前建置是否含 GPU 加速，並提示雲端 LLM 長時間翻譯的費用累積與 VRAM 共用風險
- [x] 7.5 新增保留行數、無語音清空秒數、點擊穿透三項設定欄位
  - 其中「保留行數」已於 2026-08-11 由任務 12.2.5／12.3 移除（改由視窗高度決定）；
    另「字級」由數值輸入改為 S／M／L／XL 選項（任務 12.2）。
- [x] 7.6 將即時字幕設定自設定頁移至即時字幕頁（抽出 `src/components/liveCaptionSettings.ts` 共用元件）
- [x] 7.7 啟動字幕前先寫入未儲存的設定，並於進行中變更設定時提示需重新啟動

## 8. 字幕浮動視窗

- [x] 8.1 於 `tauri.conf.json` 宣告字幕視窗（無邊框、永遠置頂、不顯示於工作列、預設隱藏）
- [x] 8.2 建立字幕視窗的前端進入點（HTML 與 TS），監聽字幕事件並渲染
- [x] 8.3 實作僅保留最近 N 段字幕的渲染邏輯，確保長時間執行不會持續累積記憶體
- [x] 8.4 實作視窗拖曳與調整大小
- [x] 8.5 實測透明背景在 Windows 的表現，若點擊穿透或陰影異常則退回不透明樣式
- [x] 8.6 實作無新字幕達設定秒數後自動清空字幕，並開放秒數設定（0 代表停用）
- [x] 8.7 實作點擊穿透：字幕文字區穿透、標題列與邊框感應區於游標移入時恢復互動
- [x] 8.8 改以視窗四邊與四角的邊框感應區調整大小，並使用 pointer capture 避免拖曳中斷
- [x] 8.9 開放同時顯示行數設定，取代原本寫死的 5 行
  - **已於 2026-08-11 由任務 12.3 取代**：實測發現手動設定行數會與視窗高度矛盾
    （視窗高 180px 卻設 5 行 28px 字幕，導致文字溢出並互相疊字）。
    改為由視窗高度與字級自動計算行數，此設定項移除。

## 9. 主視窗控制介面

- [x] 9.1 建立 `src/api/liveCaption.ts` 封裝所有即時字幕的 invoke 呼叫
- [x] 9.2 建立 `src/pages/liveCaption.ts` 控制面板（來源選擇、啟停按鈕、狀態顯示）
- [x] 9.3 於 `src/main.ts` 註冊路由，並於導航列加入入口
- [x] 9.4 實作錯誤訊息顯示（啟動失敗、session 中斷）

## 10. 實測與調校

- [ ] 10.1 以實際 YouTube 影片實測中文語音的字幕正確性與延遲
  - 2026-08-11：**英文影片已驗證轉錄正確**（取樣率修正後，字幕內容與語音相符，
    重疊去重亦正常運作，未見重複段落）。中文語音尚待實測。
- [ ] 10.2 以實際英文影片實測翻譯品質與延遲
  - 2026-08-11：轉錄已正確，但實測時 `live_caption_translate = false`，
    翻譯品質尚未驗證。
- [ ] 10.3 調校視窗長度、步進與靜音門檻的預設值，並記錄實測結果
  - **2026-08-11 實測（英文影片、local_whisper、system 音訊、RTX 5060）**
  - **主因（已確認並修正）：loopback 音訊被重複降取樣，送入模型的音訊約為 3 倍速。**
    以 WAV 實際輸出送進 whisper 的視窗音訊供人耳確認，聽到的是快轉的花栗鼠聲——
    此為取樣率標示錯配的明確特徵（混疊只會使聲音變糊，不會改變音高）。
    成因：`initialize_client` 以 `desired_format`（16 kHz）搭配 `autoconvert: true`
    初始化成功，擷取端交付的已是 16 kHz；但程式又以 `get_mixformat()` 取得
    **音訊引擎**的共用格式（48 kHz）判斷需重採樣，把已正確的 16 kHz 再降一次，
    等效內容變成約 5.3 kHz 卻仍標記為 16 kHz。
    修正：移除以 `get_mixformat()` 取樣率為準的重採樣分支，一律以初始化成功的
    `desired_format` 為準。`get_mixformat()` 的值改為僅作診斷輸出。
  - **驗證方法的教訓**：此問題連續數輪僅靠 log 判讀而未收斂，期間曾兩度做出
    錯誤結論（先誤判為重複降取樣後又自行推翻、再誤判為缺少抗鋸齒濾波導致混疊）。
    真正定案的是「把送進模型的 buffer 寫成 WAV 用人耳確認」，成本約 15 行程式碼。
    日後遇到「轉錄結果與語音無關」類問題，應優先做此驗證再讀 log。
  - 音訊振幅統計正常但內容錯誤：視窗 peak=0.89、rms=0.115、非零樣本 100%。
    振幅統計無法反映取樣率錯配，不可作為音訊正確的依據。
  - **GPU 建置原本未生效**：`cargo build` 未帶 `--features live-caption-cuda` 時
    log 顯示 `whisper_backend_init_gpu: no GPU found`，為 CPU 推論。
    帶 feature 後確認 `using CUDA0 backend`。任務 1.5 原標記完成但實際未套用於 dev 執行。
  - **模型幻覺為上述音訊問題的「症狀」，非獨立主因**：音訊被 3 倍速化後，
    模型每段都輸出 `"Thank you for watching!"`（首 token 機率僅 0.057–0.061、
    `avg_logprobs ≈ -0.97`、但 `no_speech_probability = 0.000`）。
    「模型高度確信有語音、卻對內容毫無把握」正是訊號本身損壞的指標。
    下列過濾機制仍保留為防線，但**不可作為主要解法**：
    原門檻 `logprob_thold = -2.0`、`entropy_thold = 3.2` 過寬（此段全數通過），
    `no_speech_thold = 0.9` 則因上游未實作而完全無效果。
  - **調整後的值**：`logprob_thold` -2.0 → **-1.2**（預設 -1.0）；
    `entropy_thold` 3.2 → **2.8**（預設 2.4）。
    但**這兩項不足以擋下實測到的幻覺**——其 -0.967 與 1.946 皆優於調整後的門檻，
    連 Whisper 預設的 -1.0 也擋不住；兩者僅為一般性把關。
    實際攔截手段為：移除無效的 `set_no_speech_thold`（上游 v1.3.0 尚未實作），
    改以逐段 `no_speech_probability()` 自行判定，上限
    `SEGMENT_NO_SPEECH_MAX = 0.6`；加上 `HALLUCINATION_MARKERS` 新增的英文套語清單。
  - **`SEGMENT_NO_SPEECH_MAX = 0.6` 目前為未經量測的初值**：先前的 token 級 log
    未包含 `no_speech_prob`，故此門檻是否落在幻覺與正常語音之間尚待驗證。
    已改為每段皆輸出該機率（不只被濾除者），下一輪實測須據此確認：
    若正常語音的機率接近或高於 0.6，須調高門檻，否則會誤刪真實字幕。
  - **注意驗證的混淆**：`"Thank you for watching!"` 同時會被英文套語清單攔截，
    因此若下一輪字幕正常，仍須看上述逐段機率的 log 才能判斷信心門檻是否有作用。
  - **視窗長度維持 5 秒／步進 3 秒**。曾評估改為 8 秒以改善語意完整度，
    但在 CPU 推論下會加劇積壓，且主因確認為幻覺而非切分，故不變更。
    GPU 生效後若仍有語句中途切斷，再依 `add-live-caption-remote-asr`
    的情境預設組合處理。
  - **靜音門檻維持 0.01**：loopback 的真靜音為精確 0，此值合理。
  - **2026-08-11 收尾**：取樣率修正後字幕內容已與語音相符，上述門檻與幻覺清單
    退居防線角色。`SEGMENT_NO_SPEECH_MAX = 0.6` 仍為未經量測的初值，
    但因主因已排除，暫不調整；待長時間實測（10.4）觀察是否誤刪正常字幕。
- [ ] 10.4 實測長時間（30 分鐘以上）執行的記憶體與 VRAM 穩定度
- [ ] 10.5 實測互斥雙向皆生效（錄音中啟動字幕、字幕中啟動錄音）、裝置失效、模型載入失敗等錯誤路徑

## 11. 文件

- [x] 11.1 於 README 的開發環境章節加入 LLVM、CMake 與（選用）CUDA Toolkit 前置需求，並說明 GPU 建置指令
- [x] 11.2 於 README 功能特色加入即時字幕說明，明確標註 Windows 限定與不支援語者分離
- [x] 11.3 於 README 說明 GGML 模型檔的取得方式與建議規格

## 12. 排版與診斷程式碼移除（規格確認後一次實作、一次驗收）

本節為 2026-08-11 實測後確認的收尾工作。取樣率主因已修正、字幕內容已正確，
此節處理呈現層問題與診斷程式碼的清除。

### 12.1 移除診斷用程式碼

- [x] 12.1.1 移除 `live_caption/mod.rs` 的 WAV 診斷輸出（`dump_window_wav`、
  `DEBUG_DUMP_WINDOWS`、`debug_dump_count` 及其呼叫點），確保交付狀態不寫入任何音訊檔
  - 已移除函式與呼叫點；`hound` 相依仍由既有錄音功能使用，不受影響。
- [x] 12.1.2 精簡逐視窗的診斷 `println!`：保留足以判斷異常的最小集合
  （後端原始輸出、幻覺攔截、逐段非語音機率超標時的攔截提示），
  移除逐視窗 peak/rms/非零樣本統計與逐段機率的例行輸出（調校期專用，主因已定位）
- [x] 12.1.3 精簡 `audio_recording/mod.rs` loopback 的每 10 批吞吐輸出
  （該輸出用於診斷取樣率與吞吐，主因已定位並修正）；保留啟動時一次性的
  裝置與格式輸出，供日後排查裝置選擇問題
- [x] 12.1.4 確認移除後 `cargo test --lib` 全數通過、無編譯警告

### 12.2 字級改為預設尺寸選項

- [x] 12.2.1 定義字級選項（S／M／L／XL）與其對應的實際像素值
  - `FONT_SIZE_PRESETS = [20, 24, 28, 36]`（`live_caption/mod.rs`），前端於
    `liveCaptionSettings.ts` 鏡射相同陣列供選單預選比對。
- [x] 12.2.2 `AppConfig` 的字級欄位改以選項值儲存，並為既有數值設定提供轉換
  （既有 `live_caption_font_size` 為數字，須對應至最接近的選項，不得讓舊設定失效）
  - 欄位型別維持 `u32`（像素），不改為字串列舉——不需要 serde 遷移，
    既有 `config.toml` 的任意數字直接可解析。改為在讀取端以
    `nearest_font_size_preset()` 收斂至最近檔位（Rust／TS 各一份，邏輯一致）。
- [x] 12.2.3 `src/types/index.ts` 同步型別
- [x] 12.2.4 `src/components/liveCaptionSettings.ts` 改為選項式 UI，移除數值輸入
- [x] 12.2.5 移除「同時顯示行數」設定項（改由視窗高度決定，見 12.3）
  - 移除 `AppConfig.live_caption_max_lines`、`LiveCaptionSettingsPayload.max_lines`
    及前端所有傳遞點；相關測試同步更新（`existing_config_gets_new_live_caption_defaults`）。

### 12.3 保留段數與呈現（原規劃「行數由視窗高度決定」，經兩輪實測後改向）

**設計歷程**（供日後參考，勿依此節推斷現況——現況見下方各任務的最終狀態）：

1. 第一版採「量測式動態行數」：依視窗高度量測 `scrollHeight`，放不下就捨去
   最舊一段。實作後使用者回報「換句時前一句立即消失」，體感類似一次只顯示
   一句，不是預期的 YouTube 字幕節奏（新句出現時前一句仍短暫並存）。
2. 過程中修正過兩個 CSS 缺陷，兩者在改回固定段數後仍然成立、不可回退：
   - `justify-content: flex-end` 搭配 column flex 容器，內容超高時會往
     起始端（畫面上方）溢出；此溢出**能被** `overflow: hidden` 裁切，
     但**不能被捲動**觸及到——曾誤判為「無法被裁切」，經釐清後修正判斷。
   - `.caption-line` 若保留預設 `flex-shrink: 1` 又疊上自身的
     `overflow: hidden`，兩者疊加會關閉瀏覽器的 automatic minimum size，
     內容超出容器時會被壓扁至趨近 0 高度而非觸發裁切或捲動，
     使量測邏輯或視覺呈現失真。故 `.caption-line` MUST 固定
     `flex: 0 0 auto`（不可壓縮），且 MUST NOT 疊加 `overflow: hidden`
     於單一字幕行本身（裁切交由外層 `#caption-list` 負責）。
3. 依使用者確認的最終行為改為**固定保留 2 段**，不開放設定、不依視窗高度
   動態增減；視窗放不下時裁切較舊一段的頂部（貼底＋外層 `overflow: hidden`），
   不減少保留段數，也不允許內容溢出視窗本體或蓋住標題列。

- [x] 12.3.1 字幕視窗保留最近固定 2 段字幕，不開放使用者設定、不依視窗高度動態增減
  - `liveCaptionOverlay.ts` 的 `RETAINED_CAPTIONS = 2`；`renderCaptions()`
    以 `captions.slice(-RETAINED_CAPTIONS)` 取得要顯示的段落，不做動態量測。
- [x] 12.3.2 單段字幕自動換行完整顯示，不因保留段數固定而受影響
  - `white-space: pre-wrap` 維持不變，換行純為 CSS 效果，與段數邏輯無關。
- [x] 12.3.3（原「監聽視窗大小變更即時重算行數」，已隨方向調整而不再適用）
  - 保留段數固定後不再需要依視窗大小重新計算，故移除先前加入的
    `ResizeObserver`。視窗大小僅影響裁切範圍，屬純 CSS 呈現，
    無需 JS 介入重新渲染。
- [x] 12.3.4 視窗過小時裁切而非減少保留段數，且不得溢出視窗或疊字
  - `#caption-list` 設 `justify-content: flex-end`（貼底）＋
    `overflow: hidden`（裁切超出頂部的部分）；`.caption-line` 設
    `flex: 0 0 auto`（不可壓縮，避免被壓扁成疊字）。效果：新句永遠完整
    可見於底部，較舊一段若放不下則只露出下半部，不蓋住標題列、不溢出
    視窗本體、不彼此重疊。
  - 待驗證：實際顯示效果（英文影片轉錄內容已兩輪確認正確，僅呈現層
    待使用者重新驗收）。
- [x] 12.3.5（原「變更字級後同步重算行數」，已隨方向調整而不再適用）
  - 保留段數不受字級影響，字級變更純粹是 CSS 變數更新，無需重新渲染。

### 12.4 驗收

- [x] 12.4.1 實測四種字級皆不疊字，新句永遠完整可見，長句正確換行
- [x] 12.4.2 實測視窗縮小到放不下 2 段時，較舊一段確實被裁切（只露下半部）
  而非消失或疊字；放大視窗後兩段皆完整可見，且不需重啟 session
- [x] 12.4.3 實測將視窗縮至最小高度時仍可正常顯示（至少最新一段完整可讀）
- [x] 12.4.4 確認執行後桌面未產生 `voxnote-live-caption-dump` 或任何音訊檔
  - **驗證前請先手動刪除桌面既有的 `voxnote-live-caption-dump` 資料夾**
    （前幾輪診斷時所產生），否則會看到舊資料夾誤判為移除失敗。
- [x] 12.4.5 確認既有桌面錄音三種模式無回歸（loopback 診斷輸出調整涉及共用程式碼）

## 13. 校稿與翻譯拆分（規格確認後實作，尚未動工）

本節為 2026-08-11 使用者提出的需求：即時字幕目前僅有單一「翻譯」開關，
應拆分為獨立的「翻譯」與「校稿」兩個選項，並在目標語言與來源語言相同時
略過不必要的 LLM 呼叫。詳細行為契約見 spec 的三項新／修改需求：
「Translation and proofreading are independent options」、
「System skips the LLM call when translation would be a no-op」、
「Live caption proofreading shares its prompt with batch transcript proofreading」。

**與批次校稿共用 prompt 的邊界**：批次校稿的 `PROOFREAD_SYSTEM`
（`ai_cmds.rs`）含時間戳記 `[MM:SS]` 與講者標記的保留規則，這些不適用於
即時字幕的單段輸入。共用範圍僅止於核心修正原則（同音字、標點、斷句），
格式相關規則不共用。

**範圍邊界（不在本節內）**：使用者同時提及「YouTube 影片先抓取既有字幕、
搭配語者分離」的構想，屬於全新的資料來源與功能範疇，需另立 change 規劃，
不併入本節。

- [ ] 13.1 抽出批次校稿的核心修正指示（同音字、標點、斷句）為共用常數，
  與批次專屬的時間戳記／講者標記規則分離
- [ ] 13.2 `AppConfig` 新增 `live_caption_proofread: bool`，並將既有
  `live_caption_translate` 的語意確認維持「是否翻譯」不變（不合併兩者）
- [ ] 13.3 實作即時字幕的校稿呼叫路徑：輸出語言等於輸入語言，使用共用核心指示，
  不開放使用者自訂 prompt
- [ ] 13.4 實作翻譯與校稿的互斥判定：目標語言≠來源語言時僅執行翻譯、
  校稿不生效；目標語言＝來源語言且僅開翻譯時，略過 LLM 呼叫直接顯示原文；
  目標語言＝來源語言且開校稿時執行校稿
- [ ] 13.5 校稿失敗的容錯：顯示未校稿原文並繼續處理後續字幕，不中止 session
- [ ] 13.6 `src/types/index.ts` 新增 `live_caption_proofread` 型別欄位
- [ ] 13.7 `src/components/liveCaptionSettings.ts` 新增校稿開關，UI 呈現
  「翻譯」「校稿」為兩個獨立選項
- [ ] 13.8 實測：中文會議內容單開校稿、單開翻譯（目標=來源時應無 LLM 呼叫）、
  同時開啟且跨語言、同時開啟且同語言，四種組合行為皆符合 spec 情境
