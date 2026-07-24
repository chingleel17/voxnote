> 註記：第 2、3、4 階段的程式碼實作已完成並通過靜態檢查（`cargo check`、`tsc --noEmit`、`python -m py_compile`），但尚未於實機（GPU）執行驗證。第 1、5 階段需 GPU 實機與 pyannote 授權 token，尚未進行。

## 1. 服務端概念驗證（部署機器，先做，決定後續走向）

- [ ] 1.1 在部署機器建立 Python/CUDA 環境，安裝 WhisperX、faster-whisper、pyannote.audio
- [ ] 1.2 下載 Breeze-ASR-26 權重，嘗試轉換為 CTranslate2 格式並以 faster-whisper 載入
- [ ] 1.3 若 CTranslate2 不相容，改用 WhisperX 的 HuggingFace pipeline 後端載入 Breeze
- [ ] 1.4 以樣本中文會議音訊跑通 WhisperX 全流程（轉錄 + 詞級對齊 + pyannote 語者分離）
- [ ] 1.5 於 HuggingFace 同意 pyannote 3.1 授權條款並在環境中配置 token（不進 repo）
- [ ] 1.6 驗證輸出品質：繁中/台灣用語、語者標籤正確性；記錄 RTF 與 VRAM 用量

## 2. 服務端 API 與部署封裝

- [x] 2.1 以 FastAPI 包一層 OpenAI 相容 `/v1/audio/transcriptions` 端點，內部呼叫 WhisperX
- [x] 2.2 端點支援參數：language、是否啟用語者分離、min/max speakers 提示
- [x] 2.3 回傳結果含分段時間戳與語者標籤（供 app 端解析為 `[MM:SS 講者X]`）
- [x] 2.7 提供健康檢查端點（如 `/health`），供 app 端「測試連線」按鈕呼叫
- [x] 2.4 於服務端加入 OpenCC（s2twp）簡轉繁 + 台灣用語後處理，確保繁體輸出
- [x] 2.5 撰寫 Docker Compose，封裝 CUDA、Python 相依（uv）、模型權重與 token 掛載
- [x] 2.6 撰寫部署與維運說明（啟動、健康檢查、升級、疑難排解；含本機測試）

## 3. app 後端整合（Rust）

- [x] 3.1 在 `src-tauri/src/config/mod.rs` 的 `AppConfig` struct 新增欄位：`local_asr_base_url`、`local_asr_speaker_hint`（預期人數，0 代表自動）；複用既有 `local_asr_model`、`asr_language`、`speaker_detection`
- [x] 3.2 在 `impl Default for AppConfig` 為新欄位補上預設值（既有 `#[serde(default)]` 已處理舊 config.toml 相容，無需另寫 migration）
- [x] 3.3 在 `src-tauri/src/asr/mod.rs` 新增 `transcribe_voxnote_asr()`：multipart 上傳音訊至 `{base_url}/v1/audio/transcriptions`，複用 AssemblyAI 的進度回報與語者分段解析邏輯
- [x] 3.4 實作回傳結果統一格式化為 `[MM:SS 講者X] text`（啟用語者分離時）與純文字（未啟用時）
- [x] 3.5 實作錯誤處理：Base URL 未設定、伺服器不可達/逾時/非成功狀態的明確錯誤訊息
- [x] 3.6 在 `src-tauri/src/commands/asr_cmds.rs` 的 provider match（`asr_cmds.rs:37`）新增 `voxnote_asr` 分支，並於 `asr/mod.rs` 的 `use` 匯入新函式

## 4. app 前端整合（TypeScript）

- [x] 4.1 在 `src/types/index.ts` 新增 provider 值（`voxnote_asr`）與相關設定型別
- [x] 4.2 在 `src/api/settings.ts` 擴充設定讀寫以涵蓋新欄位
- [x] 4.3 在 `src/pages/settings.ts` 新增「VoxNote 轉錄服務」供應商選項與連線設定 UI（Base URL、語言、語者分離開關、預期人數）
- [x] 4.4 加入伺服器連線測試按鈕（打健康檢查端點，回報可達性）

## 5. 驗證與交付

- [ ] 5.1 端到端測試：app 選 `voxnote_asr` → 部署服務 → 逐字稿正確回傳並含語者標籤
- [ ] 5.2 錯誤路徑測試：Base URL 空、伺服器關閉、逾時的降級提示
- [ ] 5.3 以實際會議錄音對 Breeze+WhisperX 與 AssemblyAI 做 A/B 品質比對並記錄結論
- [ ] 5.4 更新 README（新增本地伺服器供應商說明與設定步驟）
