# VoxNote 自架 ASR 服務

本服務以 Breeze-ASR-26 與 WhisperX 提供 OpenAI 相容的轉錄端點，支援語者分離與繁體中文台灣用語後處理，供在自有環境中部署、由 VoxNote app 透過 HTTP 呼叫。

## 目前狀態

API、Docker 與部署契約已完成；`app.py` 的 Breeze-ASR-26 載入、WhisperX 詞級對齊與 pyannote 語者分離流程已實作（惰性載入，參數可經環境變數調整）。尚未在具備 GPU 的機器上實機驗證，需先確認 Breeze 權重的可用載入方式（CTranslate2 或 HF pipeline 後端）與實際品質。

## 首次部署 Checklist

在要部署的機器（需具備 NVIDIA GPU）上，依序完成下列步驟。前三步是 `docker build` 不會代勞、必須事先準備的前置作業。

- [ ] **1. 準備 GPU 執行環境**
  安裝 NVIDIA Driver、Docker Engine 與 NVIDIA Container Toolkit。驗證容器可存取 GPU：
  ```bash
  docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
  ```
  能列出 GPU 資訊即代表 `docker-compose.yml` 的 `gpus: all` 可正常生效。

- [ ] **2. 準備 pyannote 授權 token（語者分離所需）**
  pyannote 3.1 為 gated model，須以 Hugging Face 帳號至模型頁面同意授權條款，取得 access token。將 token 寫入 `server/secrets/hf_token`（單行純文字）：
  ```bash
  mkdir -p server/secrets
  printf '%s' 'hf_你的_token' > server/secrets/hf_token
  ```
  此檔含機密，已由 `.gitignore` 排除，切勿提交版控。若暫不啟用語者分離，可略過此步。

- [ ] **3. 準備 Breeze-ASR-26 權重**
  下載或轉換 Breeze-ASR-26 權重，放到 `server/models/breeze-asr-26`（此目錄已由 `.gitignore` 排除）。或改以環境變數 `BREEZE_MODEL_DIR` 指定其他路徑 / Hugging Face repo 名稱。

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

本服務以 [uv](https://docs.astral.sh/uv/) 管理 Python 環境，請勿將相依安裝至全域 Python。WhisperX / CTranslate2 / pyannote 對 Python 3.13 支援尚不完整，`pyproject.toml` 已限定 `>=3.10,<3.13`。

```bash
cd server
uv sync                 # 建立隔離的 .venv 並安裝相依
uv run uvicorn app:app --host 0.0.0.0 --port 8000
```

torch 的 CUDA 版本請依 NVIDIA 官方索引安裝（對應主機 CUDA 版本），必要時以 `uv pip install torch --index-url https://download.pytorch.org/whl/cu124` 覆蓋。

## 環境變數

| 變數 | 說明 | 預設 |
| --- | --- | --- |
| `BREEZE_MODEL_DIR` | Breeze 權重目錄或 Hugging Face repo 名稱 | `MediaTek-Research/Breeze-ASR-26` |
| `ASR_DEVICE` | 推論裝置 | `cuda` |
| `ASR_COMPUTE_TYPE` | 運算精度；VRAM 較小建議 `int8`，較充裕可用 `float16` | `int8` |
| `ASR_BATCH_SIZE` | 批次大小；VRAM 較小時調降 | `8` |
| `HF_TOKEN` / `HF_TOKEN_FILE` | Hugging Face token（語者分離所需），可直接給值或指向檔案 | 無 |
| `UPLOAD_DIR` | 上傳音訊暫存目錄 | 系統暫存目錄 |

## app 端設定

在 VoxNote 的「設定 > 語音轉錄」選擇「VoxNote 轉錄服務」，Base URL 填入服務位址（例如 `http://192.168.0.10:8000`）。設定頁的「測試連線」會呼叫 `/health`。本服務預設無驗證機制，請部署於受信任的網路環境。

`POST /v1/audio/transcriptions` 使用 multipart：`file` 為音訊檔；可選 `language`、`diarize`、`min_speakers` 與 `max_speakers`。回應的 `segments` 陣列含秒數 `start`、`end`、`text` 與啟用語者分離時的 `speaker`。

## 小 VRAM 機器的冒煙測試

VRAM 較小（例如 8GB）的 GPU 可用於 API 冒煙測試，但不適合作為正式長會議服務。建議採較保守的設定：

1. 將 `ASR_COMPUTE_TYPE` 設為 `int8`，`ASR_BATCH_SIZE` 降為 1 至 2。
2. 先停用 `diarize`，確認基本轉錄後再啟用 pyannote；語者分離會增加 VRAM 與處理時間。
3. 若發生 CUDA 記憶體不足，縮短音檔、降低 batch size，或改用 CPU 模式驗證 API 契約。

完成冒煙測試後，仍須在具備足夠 VRAM 的正式部署機器上進行實際錄音的品質、RTF 與 VRAM 驗證。
