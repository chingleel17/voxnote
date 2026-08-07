# VoxNote 自架 ASR 服務

本服務以 Breeze-ASR-26 與 WhisperX 提供 OpenAI 相容的轉錄端點，支援語者分離與繁體中文台灣用語後處理，供在自有環境中部署、由 VoxNote app 透過 HTTP 呼叫。

## 目前狀態

API、Docker 與部署契約已完成；`app.py` 的 Breeze-ASR-26 載入、WhisperX 詞級對齊與 pyannote 語者分離流程已實作（惰性載入，參數可經環境變數調整）。尚未在具備 GPU 的機器上實機驗證，需先確認 Breeze 權重的可用載入方式（CTranslate2 或 HF pipeline 後端）與實際品質。

## 首次部署 Checklist

在要部署的機器（需具備 NVIDIA GPU）上，依序完成下列步驟。前三步是 `docker build` 不會代勞、必須事先準備的前置作業。

- [x] **1. 準備 GPU 執行環境**
  安裝 NVIDIA Driver、Docker Engine 與 NVIDIA Container Toolkit。驗證容器可存取 GPU：
  ```bash
  docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
  ```
  能列出 GPU 資訊即代表 `docker-compose.yml` 的 `gpus: all` 可正常生效。

- [ ] **2. 準備 pyannote 授權 token（語者分離所需）**
  以 Hugging Face 帳號至 [pyannote-community/speaker-diarization-community-1](https://huggingface.co/pyannote-community/speaker-diarization-community-1) 接受使用條款，並於 [設定頁](https://huggingface.co/settings/tokens) 建立 access token。將 token 寫入 `server/secrets/hf_token`（單行純文字）：
  ```bash
  mkdir -p server/secrets
  printf '%s' 'hf_你的_token' > server/secrets/hf_token
  ```
  此檔含機密，已由 `.gitignore` 排除，切勿提交版控。若暫不啟用語者分離，可略過此步。

  兩點注意：
  - **須確認接受的是 `DIARIZATION_MODEL` 實際指定的那個模型**。WhisperX 內建預設會隨版本變動且指向受限的 `pyannote/` 鏡像，授權與實際載入的模型不符時會得到 HTTP 403 gated repo 錯誤。本服務已明確指定模型以避免此問題。
  - 若改用舊版 `pyannote/speaker-diarization-3.1`，**須額外接受其相依的 [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) 授權**（兩道授權門）；community-1 僅需一道，且語者計數與指派表現更佳（中文會議語料 AliMeeting DER 24.5% → 20.3%）。

- [ ] **3. 準備 ASR 模型**
  預設使用 Breeze-ASR-26（台灣用語最佳）。它以 safetensors 發布，須先轉為 CTranslate2 格式才能被 faster-whisper 載入。以下指令會自動下載（約 6 GB）並轉檔至 `server/models/asr-model`（此目錄已由 `.gitignore` 排除）：

  ```bash
  cd server
  uv run ct2-transformers-converter --model MediaTek-Research/Breeze-ASR-26 --output_dir models/asr-model --quantization float16 --copy_files tokenizer_config.json preprocessor_config.json vocab.json merges.txt added_tokens.json special_tokens_map.json normalizer.json generation_config.json
  ```

  三點提醒：
  - **`--copy_files` 清單勿照抄網路範例**。多數教學寫 `tokenizer.json`，但 Breeze 的 repo 並無此檔（只有 `tokenizer_config.json`），照抄會失敗；上方清單為該 repo 實際存在的檔案。
  - **量化建議用 `float16`**。CTranslate2 允許存檔精度與執行精度不同：float16 的權重可在執行時以 `ASR_COMPUTE_TYPE=int8` 載入（載入時即時量化），因此同一份權重可同時服務小 VRAM 與大 VRAM 機器；若直接轉成 int8 則無法回復較高精度。
  - **若輸出目錄已存在會中止**（`docker compose` 可能已為 bind mount 自動建立空目錄）。確認目錄為空後，加上 `--force` 覆寫即可。

  若想改用其他模型，設定 `ASR_MODEL` 環境變數即可（詳見下方「選擇 ASR 模型」）；使用 WhisperX 內建代號（如 `large-v3`）時可略過本步驟，模型會自動下載，無須轉檔。

- [ ] **4. 啟動服務**
  ```bash
  cd server
  docker compose up -d --build
  ```

- [ ] **5. 驗證健康檢查**
  ```bash
  curl http://localhost:8000/health
  ```
  應回傳 `status` 為 `ok` 的 JSON。

- [ ] **6. 驗證轉錄品質**
  以一段實際會議錄音呼叫轉錄端點，確認繁體中文台灣用語、語者標籤正確性，並記錄處理速度（RTF）與 VRAM 用量，作為調整 `ASR_COMPUTE_TYPE`、`ASR_BATCH_SIZE` 的依據。

> 模型權重與 Hugging Face 快取以 volume 掛載，重建容器不會重新下載。升級時重新執行 `docker compose up -d --build`，再以健康檢查確認狀態。

## 不使用 Docker 的本機開發（uv）

本服務以 [uv](https://docs.astral.sh/uv/) 管理 Python 環境，請勿將相依安裝至全域 Python。`pyproject.toml` 已限定 `>=3.11,<3.13`：onnxruntime（pyannote 間接相依）不支援 3.10，WhisperX / CTranslate2 / pyannote 對 3.13 支援則尚不完整。若本機 Python 版本不符，執行 `uv sync` 時 uv 會自動下載 3.11。

```bash
cd server
uv sync                 # 建立隔離的 .venv 並安裝相依
uv run uvicorn app:app --host 0.0.0.0 --port 8000
```

torch 的 CUDA 版本請依 NVIDIA 官方索引安裝（對應主機 CUDA 版本），必要時以 `uv pip install torch --index-url https://download.pytorch.org/whl/cu124` 覆蓋。

## 選擇 ASR 模型

本服務基於 WhisperX 框架，ASR 模型可插拔，透過 `ASR_MODEL` 環境變數指定。可填入的值：

- **WhisperX 內建模型代號**（免轉檔、即裝即用）：如 `large-v3`、`medium`、`small`。適合需要多語言通用辨識、或使用者環境資源有限時降尺寸使用。
- **本地 CTranslate2 模型目錄**：如 `/models/asr-model`。用於自備權重（含 Breeze-ASR-26）。
- **Hugging Face repo 名稱**：如 `MediaTek-Research/Breeze-ASR-26`（預設值，台灣用語最佳）。

注意：WhisperX 走 faster-whisper (CTranslate2) 後端，任何自訂 fine-tune 模型（如 Breeze）須先轉為 CTranslate2 格式才能載入；原版 Whisper 系列則由 WhisperX 自動處理。語者分離（pyannote）與所選 ASR 模型無關，兩者皆可搭配。

## 環境變數

| 變數 | 說明 | 預設 |
| --- | --- | --- |
| `ASR_MODEL` | ASR 模型：CTranslate2 目錄、HF repo 名稱，或 WhisperX 內建代號（如 `large-v3`）。相容別名 `BREEZE_MODEL_DIR` | `MediaTek-Research/Breeze-ASR-26` |
| `ASR_DEVICE` | 推論裝置 | `cuda` |
| `ASR_COMPUTE_TYPE` | 運算精度；VRAM 較小建議 `int8`，較充裕可用 `float16` | `int8` |
| `ASR_BATCH_SIZE` | 批次大小；VRAM 較小時調降 | `8` |
| `DIARIZATION_MODEL` | 語者分離模型（明確指定，不依賴 WhisperX 會變動的預設值） | `pyannote-community/speaker-diarization-community-1` |
| `HF_TOKEN` / `HF_TOKEN_FILE` | Hugging Face token（語者分離所需），可直接給值或指向檔案 | 無 |
| `UPLOAD_DIR` | 上傳音訊暫存目錄 | 系統暫存目錄 |
| `AUDIO_PREPROCESS` | 音訊前處理總開關；設為 `0` 可停用以比對效果 | `1` |
| `AUDIO_HIGHPASS_HZ` | 高通濾波截止頻率（Hz），濾除冷氣與桌面震動等低頻噪音；設為 `0` 停用 | `80` |
| `AUDIO_NORMALIZER` | 響度標準化方式：`loudnorm`、`dynaudnorm` 或 `none` | `loudnorm` |

### 音訊前處理

手機置於會議桌收音的錄音常有兩個問題：低頻的冷氣與桌面震動噪音，以及整體響度偏低使語音接近底噪。前處理在 WhisperX 既有的 ffmpeg 解碼命令上追加 filter，不額外增加 I/O，且輸出樣本數與未處理時完全一致，不影響時間戳對齊。

各方式的取捨（實測 60 分鐘音訊的總耗時，以及語音與靜音段的訊噪比；SNR 越高代表語音相對底噪越清楚，直接影響語者分離的聲紋品質）：

| 方式 | 60 分鐘耗時 | SNR | 語音提升 |
| --- | --- | --- | --- |
| 原始（`AUDIO_PREPROCESS=0`） | 約 1.4 秒 | 33.7 dB | — |
| `loudnorm`（預設） | 約 35 秒 | 33.2 dB | +21.0 dB |
| `dynaudnorm` | 約 2.3 秒 | 27.2 dB | +16.9 dB |

`dynaudnorm` 雖快得多，但逐段調整增益會在語音停頓處把底噪一併放大，實測損失約 6.5 dB SNR，與提升語者分離的目標相反。因此預設採 `loudnorm`；若長錄音無法接受其耗時，再改用 `dynaudnorm`。

比對前處理是否有效的方式：對同一段實際會議錄音，分別以 `AUDIO_PREPROCESS=0` 與 `1` 轉錄，比較語者標籤的正確性。

## app 端設定

在 VoxNote 的「設定 > 語音轉錄」選擇「VoxNote 轉錄服務」，Base URL 填入服務位址（例如 `http://192.168.0.10:8000`）。設定頁的「測試連線」會呼叫 `/health`。本服務預設無驗證機制，請部署於受信任的網路環境。

`POST /v1/audio/transcriptions` 使用 multipart：`file` 為音訊檔；可選 `language`、`diarize`、`min_speakers` 與 `max_speakers`。回應的 `segments` 陣列含秒數 `start`、`end`、`text` 與啟用語者分離時的 `speaker`。

## 小 VRAM 機器的冒煙測試

VRAM 較小（例如 8GB）的 GPU 可用於 API 冒煙測試，但不適合作為正式長會議服務。建議採較保守的設定：

1. 將 `ASR_COMPUTE_TYPE` 設為 `int8`，`ASR_BATCH_SIZE` 降為 1 至 2。
2. 先停用 `diarize`，確認基本轉錄後再啟用 pyannote；語者分離會增加 VRAM 與處理時間。
3. 若發生 CUDA 記憶體不足，縮短音檔、降低 batch size，或改用 CPU 模式驗證 API 契約。

完成冒煙測試後，仍須在具備足夠 VRAM 的正式部署機器上進行實際錄音的品質、RTF 與 VRAM 驗證。
