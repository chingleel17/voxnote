## Context

VoxNote 現有 ASR 有兩條路徑（`src-tauri/src/asr/mod.rs`）：雲端 `assemblyai`（HTTP 上傳+輪詢，支援 `speaker_labels` 語者分離）與本地 `whisper` CLI（子行程呼叫，無語者分離、繁中弱）。供應商以 `config.asr_provider` 字串在 `asr_cmds.rs` 分派，輸出統一為 `[MM:SS 講者X] text`。

在具備 24GB VRAM 的 GPU 伺服器上，需在自有網路部署繁中/台灣用語最佳、含語者分離的本地 ASR，取代對雲端的依賴。經研究，通用英文榜首模型（Parakeet、Cohere）繁中非強項；華語模型 Qwen3-ASR 準確度高但輸出簡體且原生無語者分離；MOSS-Transcribe-Diarize 雖整合語者分離但中文偏通用語料。台灣用語專門優化的唯一選擇是聯發科 **Breeze-ASR-26**（Apache-2.0），但它是 Whisper fine-tune，無原生語者分離。

## Goals / Non-Goals

**Goals:**
- 在 GPU 伺服器上部署以 Breeze-ASR-26 為核心的 ASR 服務，繁中/台灣用語與中英夾雜辨識品質最佳。
- 提供語者分離（會議逐字稿的硬需求）。
- 對外提供 OpenAI 相容 `/v1/audio/transcriptions` 端點，讓 app 端整合成本最小化（複用 AssemblyAI 的 HTTP 邏輯）。
- app 端新增 `voxnote_asr` 供應商，資料不出自有網路。

**Non-Goals:**
- 不使用 Ollama 承載 ASR（Ollama 僅支援 LLM/視覺，不支援音訊模型）。
- 不在使用者本機直接跑模型（避免打包 GPU 相依與大權重）。
- 不做即時串流字幕（另立 change）。
- 服務端不追求多租戶/認證機制（內網信任環境；YAGNI）。

## Decisions

### 決策 1：轉錄後端用 Breeze-ASR-26，不用 Qwen3-ASR / MOSS-TD

Breeze-ASR-26 是唯一針對台灣口音與用語、中英夾雜（code-switching 較 stock Whisper +56%）優化的開源模型，直接命中會議場景的核心痛點。Qwen3-ASR 雖 CER 數字更低，但語料偏大陸普通話、輸出簡體字，與台灣用語硬需求相衝突。MOSS-TD 雖整合語者分離，中文偏通用語料，台灣用語不如 Breeze。

*替代方案*：MOSS-TD（整合最省事）——保留為 fallback，若 Breeze+WhisperX 組裝成本過高可回退。

### 決策 2：語者分離用 WhisperX 流程（faster-whisper + pyannote 3.1）

Breeze 無原生語者分離。WhisperX 已將「faster-whisper 批次轉錄 → wav2vec2 詞級強制對齊 → pyannote 3.1 語者分離 → 詞到語者指派」整合為一條 pipeline，是 2026 年自架轉錄+語者分離的主流方案。Breeze-ASR-26 為 Whisper 相容架構，可透過 CTranslate2 轉檔後由 faster-whisper 載入，直接作為 WhisperX 的 ASR 後端。

*替代方案*：自行接 pyannote + 手寫時間戳對齊——工程量大且易錯，不採用。

### 決策 3：以 Docker Compose 部署服務端，對外 OpenAI 相容端點

服務端包一層 FastAPI，暴露 `/v1/audio/transcriptions`（OpenAI 格式），內部呼叫 WhisperX。以 Docker Compose 封裝 CUDA 環境、Python 相依與模型權重，讓部署機器一鍵啟動、易於維運與升級。app 端因此只需 HTTP 呼叫，零 Rust 相依新增。

*替代方案*：直接跑 vLLM Whisper 端點——但 vLLM 的 Whisper 路徑不含 pyannote 語者分離，仍要另接，不如 WhisperX 一體。

### 決策 4：app 端新增 `voxnote_asr` 供應商，複用 AssemblyAI 邏輯

在 `asr/mod.rs` 新增 `transcribe_voxnote_asr()`，沿用 AssemblyAI 的 multipart 上傳與語者分段解析，將回傳統一為 `[MM:SS 講者X] text`。`asr_cmds.rs` 的 match 加一個分支。設定沿用既有 `local_asr_model` 欄位，新增 `local_asr_base_url` 等連線設定。

### 決策 5：繁體輸出保險——服務端簡轉繁後處理

Breeze 主要輸出繁體，但為保險，服務端於回傳前套用 OpenCC（s2twp）簡轉繁 + 台灣用語轉換，確保 100% 符合台灣用語硬需求，避免 app 端額外處理。

## Risks / Trade-offs

- **Breeze 權重轉 CTranslate2 相容性未經實測** → 先在部署機器用小段音訊驗證 Breeze→CTranslate2→faster-whisper 可正常載入推論；若不相容，改用 HuggingFace pipeline 後端（WhisperX 支援）或回退決策 1 的 MOSS-TD。
- **pyannote 3.1 需 HuggingFace 授權同意** → 維運端一次性以 HF 帳號同意條款並在容器內配置 token（不進 app、不進 repo）。
- **語者數未知時分離品質波動** → pyannote 支援 `min_speakers`/`max_speakers` 提示；設定頁可選填預期人數以提升準確度。
- **部署機器為單點** → 內網服務；app 端需處理伺服器不可達的降級（回退提示使用者改用雲端或本地 Whisper），不阻斷整體流程。
- **長音訊記憶體/耗時** → WhisperX 批次推論在 24GB 足夠；長會議以分段處理，透過既有進度事件回報。

## Migration Plan

1. 部署機器：建立 Docker Compose，拉取 Breeze-ASR-26 權重、配置 pyannote token，啟動服務並以樣本音訊驗證端點。
2. app：新增 `voxnote_asr` 供應商與設定欄位（feature 分支）。
3. 以實際會議錄音對 Breeze+WhisperX 與現有 AssemblyAI 做 A/B 品質比對。
4. 驗收通過後，設定頁預設仍保留使用者可切換；雲端/本地 Whisper 路徑不移除，作為降級選項。

**Rollback**：app 端供應商為附加選項，移除 `voxnote_asr` 分支即回到現狀；服務端停用 compose 即可，無資料庫破壞性變更。

## Open Questions

- Breeze-ASR-26 轉 CTranslate2 後精度損失是否可接受？（需實機實測）
- 服務端是否需要簡易 API key 保護，即使在內網？（預設不做，視組織資安政策）

## Resolved Decisions（已定案）

- **PoC 只先跑 Breeze**：第 1 階段集中驗證 Breeze+WhisperX，不並行跑 MOSS-TD。轉 CTranslate2 若失敗，依序回退：HF pipeline 後端 → 最後才考慮 MOSS-TD。避免 PoC 工量加倍。
- **講者人數採可選填**：設定頁提供選填欄位（空=自動偵測），傳給服務端作為 pyannote 的 min/max_speakers 提示；對應 `local_asr_speaker_hint` 設定欄位（0 代表自動）。
  - 註：此決策已由後續 change `use-meeting-participants-for-diarization` 取代——人數改為自動取自會議的與會人員數，設定頁欄位已移除。
- **納入伺服器連線測試按鈕**：設定頁提供「測試連線」按鈕打服務端健康檢查端點；服務端需一併提供健康檢查端點（納入第 2 階段服務端範圍）。
