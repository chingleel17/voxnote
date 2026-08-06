## Context

動機見 [proposal.md](./proposal.md) 的 Why；行為契約見 [specs/live-caption-overlay/spec.md](./specs/live-caption-overlay/spec.md)。此處只記錄形塑實作方式的現況與限制。

**既有可重用資產**
- `audio_recording/mod.rs` 已有 WASAPI loopback 擷取（`start_windows_loopback_capture`）、麥克風 cpal 串流、降混與線性重取樣（`downmix_and_resample`），以及 `SharedQueue` 消費模式。
- `ai/mod.rs` 的 `call_llm(config, system_prompt, user_content)` 可直接用於翻譯。
- `asr/mod.rs` 的 `transcribe_voxnote_asr` 已能對自架服務發出 multipart 轉錄請求。
- 既有錄音以 `RECORDING_LEVEL_EVENT` 向前端推送事件，即時字幕沿用同樣的 `app.emit` 模式。

**關鍵限制（經查證）**
- `whisper.cpp` 的 `whisper-stream` 範例**只能由 SDL2 擷取麥克風**，不接受 stdin 或檔案輸入（[ggml-org/whisper.cpp#3080](https://github.com/ggml-org/whisper.cpp/issues/3080) 自 2025-04 開啟至今未實作）。因此無法將 WASAPI loopback 擷取到的系統音訊餵給該執行檔——**以外部 whisper.cpp 執行檔實作本功能的路徑不可行**。
- `whisper-rs-sys` 由原始碼建置 whisper.cpp，build dependencies 含 `bindgen`（需 LLVM/libclang）與 `cmake`。
- 開發機為 NVIDIA RTX 5060（8 GB VRAM）。VRAM 由 whisper 模型與（若使用 Ollama）翻譯模型共用。
- 專案無任何測試（見 `AGENTS.md`），驗證以手動實測為主。

## Goals / Non-Goals

**Goals**
- 即時字幕的音訊擷取沿用既有 WASAPI/cpal 程式碼，不重複實作，且不改變既有錄音的行為。
- 本地轉錄路徑不依賴外部執行檔，音訊不離開本機。
- 建置環境對未安裝 CUDA Toolkit 的開發者與 CI 仍可完成編譯。

**Non-Goals**（設計層邊界，範圍見 proposal）
- 不實作即時語者分離、不持久化字幕、不支援非 Windows 的系統音訊擷取。
- 不實作即時字幕與一般錄音的並行執行（見 Decision 6）。
- 不自動下載或管理 GGML 模型檔，由使用者自備並指定路徑。

## Decisions

### 1. 本地轉錄以 `whisper-rs` 行程內載入，而非呼叫外部執行檔

**選擇**：新增 `whisper-rs` 0.16（Unlicense，2026-03 更新，約 83 萬次下載）作為相依，以 `WhisperContext` 載入 GGML 模型，對每個音訊視窗呼叫 `WhisperState::full()` 取得文字。

**理由**：`whisper-stream` 無法接受管線輸入（見 Context），外部執行檔路徑在技術上不可行。行程內整合另有三項優勢：模型只載入一次而非每段重載、免去每段寫暫存 WAV 的磁碟 I/O、不需使用者另行安裝執行檔。

**執行緒**：`WhisperState::full()` 為同步阻塞呼叫，單次推論可達數秒。轉錄迴圈 MUST 執行於專屬 OS 執行緒（沿用既有錄音以 `thread::spawn` 管理 session 的做法），**不可**放在 tokio async runtime 上，否則會阻塞整個 executor。

**替代方案**
- *外部 `whisper-cli` 逐段呼叫*：每段需寫暫存檔並重新載入模型（數 GB 權重），延遲不可接受。
- *`whisper-cpp-plus-rs`*：提供現成的 PCM 串流與 VAD API，但僅 8 星、單一貢獻者，不適合作為核心相依。其文件指出 fixed-step 模式會跨回呼重複輸出文字、需呼叫端自行調解——此問題我們同樣會遇到（見 Decision 4）。

### 2. CUDA 為 opt-in cargo feature，預設建置走 CPU

**選擇**：`whisper-rs` 以 `default-features = false` 引入，另定義專案層級 feature（如 `live-caption-cuda`）轉開 `whisper-rs/cuda`。預設 `cargo build` 不啟用 GPU。

**理由**：`cuda` feature 使建置需要 CUDA Toolkit（`nvcc`）。若設為預設，所有貢獻者與 GitHub Actions CI 都必須安裝 CUDA 才能編譯專案，且產出的執行檔在無 CUDA 執行環境無法啟動。opt-in 讓專案維持可建置，開發機仍可自行開啟 GPU 加速。

**代價**：LLVM/libclang 與 CMake 成為**無條件**的建置需求（`bindgen` 與 `cmake` 是 `whisper-rs-sys` 的必要 build dependency，非 GPU 專屬）。此為引入本地 whisper 的固有成本，需寫入 README 的開發環境章節。

### 3. 取樣率參數化，音訊在來源端即產出 16 kHz

**選擇**：兩條音訊路徑都要參數化目標取樣率，既有錄音呼叫端傳入現行的 48 kHz，即時字幕傳入 16 kHz。

- **麥克風路徑**：將 `downmix_and_resample` 的目標取樣率由模組常數改為函式參數。
- **系統音訊（loopback）路徑**：此路徑**不經過** `downmix_and_resample`——`start_windows_loopback_capture` 於 `audio_recording/mod.rs:617` 以 `WaveFormat::new(..., TARGET_SAMPLE_RATE, 2, ...)` 向 WASAPI 要求格式，並在 `:638` 自行以 `(left + right) * 0.5` 降混後直接推入佇列。因此須另行參數化該 `WaveFormat::new` 所要求的取樣率。

**理由**：whisper 模型要求 16 kHz f32 mono。若沿用 48 kHz 再降取樣一次，等於多做一次有損重取樣，且送往自架服務的位元組數為三倍而無精度增益。系統音訊是本功能的主要使用情境（觀看影片），該路徑若遺漏會導致送入模型的取樣率錯誤。

**注意**：WASAPI 共享模式下 `autoconvert: true` 的格式請求**不保證被接受**，裝置可能回退為混音器格式。實作時須於 `initialize_client` 後實際查詢生效的格式，並依實際取樣率決定是否仍需軟體重取樣，不可假設請求必然成立。

### 4. 滑動視窗與重疊調解由本專案實作

**選擇**：以固定步進的滑動視窗切分音訊（視窗長度與重疊量作為可調參數），相鄰視窗重疊；對轉錄結果做尾首重疊比對，去除與前一段重複的文字後才輸出字幕。靜音門檻以既有 `push_resampled_samples` 已計算的 peak 值判定，低於門檻的視窗不送轉錄。

**理由**：`whisper-rs` 只提供「對一段 buffer 轉錄」的原語，重疊、去重、靜音跳過皆須自行實作。重疊是避免邊界切字的必要手段，而重疊必然導致相鄰段輸出重複文字，因此去重與重疊必須成對實作——這是一項實質工作，不是細節。

**風險**：重疊調解為啟發式，無法保證完美。實際視窗長度與重疊量須以實測調校（見 Risks）。

### 5. 翻譯沿用全域 LLM 設定，逐段呼叫

**選擇**：以既有 `call_llm()` 與全域 `llm_provider` 設定翻譯每段字幕，不另設獨立供應商欄位。翻譯失敗時輸出原文並繼續（spec 已規範）。

**理由**：設定項最少、與校稿摘要行為一致。使用者若在意成本，可自行將全域供應商切為 Ollama。

**代價**：連續觀看時每 3–5 秒一次 LLM 請求，一小時約產生 700–1200 次呼叫。使用雲端供應商時費用會累積，需於設定頁明確提示。

### 6. 即時字幕與一般錄音互斥

**選擇**：即時字幕與桌面錄音不可同時進行，啟動其一時若另一方進行中則拒絕並回報原因。以獨立的 `LiveCaptionManager` 管理 session，與 `DesktopRecordingManager` 並存但互相檢查狀態。

**理由**：並行需要在同一 render 裝置上開第二個 WASAPI loopback 用戶端，或將單一擷取分流給兩個消費者，兩者皆增加實質複雜度與失敗模式。目前使用情境（觀看影片時看字幕）不需要並行。互斥的實作成本接近零，且日後要放寬限制不會破壞既有契約。

**注意**：spec 的「MUST 僅允許一個即時字幕 session」僅涵蓋字幕自身；此互斥規則為額外的設計層決定，實作時兩處檢查都要有。

### 7. 字幕以獨立 Tauri 視窗呈現

**選擇**：於 `tauri.conf.json` 宣告第二個視窗（`decorations: false`、`alwaysOnTop: true`、`skipTaskbar: true`、`transparent: true`），使用獨立的前端進入點，僅監聽字幕事件並渲染最近 N 段。session 停止時關閉該視窗。

**理由**：使用者需將字幕疊放於影片播放器上方，主視窗內的頁面無法達成。獨立視窗亦讓字幕渲染與主視窗狀態解耦。

**注意**：`transparent: true` 在 Windows 上需留意點擊穿透與陰影行為，實作時須實測；若造成問題，退回不透明背景加低不透明度樣式。

## Risks / Trade-offs

- **視窗切分導致語句被截斷、字幕不連貫** → 相鄰視窗重疊加尾首去重（Decision 4）。實際參數須以真實影片實測調校，先以視窗 5 秒／步進 3 秒為起點。

- **8 GB VRAM 需由 whisper 模型與翻譯模型共用** → 文件建議本地模型選 `small` 或 `medium` 等級而非 `large`；若使用者將全域 LLM 設為 Ollama 並載入大模型，可能發生記憶體不足。設定頁需提示此組合。

- **CPU 模式下延遲可能不可接受** → CUDA 為 opt-in，未啟用 GPU 時延遲會明顯拉長。README 需說明 GPU 建置方式，並在設定頁顯示目前建置是否含 GPU 加速。

- **建置門檻上升（LLVM + CMake 成為必要）** → 無法避免（Decision 2 代價）。以 README 前置需求章節與明確的建置錯誤訊息緩解。

- **每段一次 LLM 請求造成雲端費用累積** → 設定頁提示，並建議長時間使用時切換至 Ollama（Decision 5）。

- **自架 ASR 服務尚未實機驗證** → 該後端目前狀態見 `server/README.md`。即時字幕以本地 whisper 為預設路徑，自架服務作為次要選項，其實測風險不阻擋本功能上線。

- **無測試可回歸** → 專案無測試基礎建設。緩解方式為改動既有錄音程式碼時嚴格限縮範圍：`downmix_and_resample` 的參數化須保持既有呼叫端行為完全不變，並以實際錄音手動驗證。

## Migration Plan

無資料庫 schema 變更、無資料遷移。新增設定欄位由 `AppConfig` 的 `#[serde(default)]` 自動補值，舊版 `config.toml` 可直接沿用。

功能為純新增，回滾方式為移除新增的 command 註冊與視窗宣告；既有流程不受影響。

## Open Questions

- 視窗長度與重疊量的最佳值需以實際影片實測決定，先以 5 秒／3 秒為預設並開放設定調整。此參數調校不影響 spec、架構或任務拆解。
- 字幕視窗的透明背景在 Windows 上的點擊穿透行為需實測確認（Decision 7），若不可行則退回不透明樣式，屬樣式層調整。
