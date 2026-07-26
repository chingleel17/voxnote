## Why

目前 VoxNote 的逐字稿只有兩條路徑：雲端 AssemblyAI（需付費、資料出境、有隱私疑慮）與本地 Whisper CLI（無語者分離、繁體中文與台灣用語辨識弱）。若具備一台 24GB VRAM 的 GPU 伺服器，可在自有網路內部署專為台灣口音與用語優化的開源 ASR 模型，同時取得雲端等級的語者分離品質，達成低成本、資料不出境、繁中/台灣用語最佳的會議逐字稿。

## What Changes

- 在 GPU 伺服器部署一個本地 ASR 推論服務：以 **Breeze-ASR-26**（聯發科，Apache-2.0，台灣口音／中英夾雜最佳）為轉錄後端，搭配 **WhisperX** 流程（faster-whisper 執行 Breeze 權重 + wav2vec2 詞級對齊 + pyannote 3.1 語者分離 + 詞到語者指派），對外提供 **OpenAI 相容 `/v1/audio/transcriptions` HTTP 端點**。
- 在 app 後端新增第三個 `asr_provider`（暫名 `voxnote_asr`），與現有 `assemblyai`、本地 `whisper` 並列；複用 AssemblyAI 既有的「上傳音訊 + 解析語者分段」邏輯，將回傳統一成現有 `[MM:SS 講者X] text` 格式。
- 設定頁新增此 provider 的選項與伺服器連線設定（Base URL、模型名稱、語言、是否啟用語者分離）。
- 服務端提供部署方式（Docker Compose 為主），供在部署機器上一鍵啟動；此為維運文件與 compose 設定，非 app 內建。

明確不做（YAGNI）：不改動 Ollama（Ollama 不支援 ASR）；不在使用者本機直接跑模型；不做即時串流字幕（另立 change）。

## Capabilities

### New Capabilities
- `local-asr-server`: 透過自架 OpenAI 相容 HTTP 端點呼叫本地 ASR 服務進行會議轉錄與語者分離，作為 AssemblyAI 與本地 Whisper CLI 之外的第三個轉錄供應商。

### Modified Capabilities
<!-- 無既有 capability spec（openspec/specs/ 目前僅有 PRD.md），故不涉及既有需求變更。 -->

## Impact

- **Rust 後端**：`src-tauri/src/asr/mod.rs` 新增 `transcribe_voxnote_asr()`；`src-tauri/src/commands/asr_cmds.rs` 的 provider match 新增 `voxnote_asr` 分支；`src-tauri/src/config/mod.rs` 新增伺服器連線設定欄位。
- **前端**：`src/pages/settings.ts`、`src/api/settings.ts`、`src/types/index.ts` 新增 provider 選項與設定欄位。
- **設定資料**：新增 `local_asr_base_url`、`local_asr_model`（複用既有欄位）、`local_asr_language` 等設定鍵；需對應 config migration 或預設值。
- **相依性**：app 端不新增 Rust crate（複用 reqwest）。服務端（部署機器）相依 Python 生態：WhisperX、faster-whisper、pyannote.audio、CTranslate2、Breeze-ASR-26 權重。
- **外部服務**：pyannote 3.1 需 HuggingFace 帳號同意授權條款以下載權重（一次性，維運端處理，非 app 端）。
- **維運**：新增部署文件與 Docker Compose；伺服器需 CUDA 環境與網路連通性（app 端可達伺服器）。
