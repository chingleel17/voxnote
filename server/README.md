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

- [ ] **3b. 即時字幕的英文模型（僅雙實例部署需要）**
  **無須任何操作**。`asr-live` 預設使用 WhisperX 內建代號 `distil-large-v3`，首次收到請求時自動下載（約 1.5 GB）至掛載的 HF 快取，不需轉檔、不需事先放檔。

  此處與步驟 3 的差異在於：Breeze 以 safetensors 發布故須自行轉為 CTranslate2；而 Whisper 系列（含 distil）由 WhisperX 直接處理。

  模型選擇建議（詳見「雙實例部署 > 即時字幕的模型選擇」）：

  | 代號 | 相對速度 | 英文品質 | 大小 |
  | --- | --- | --- | --- |
  | `distil-large-v3`（預設） | 約 6× | 接近 large-v3 | ~1.5 GB |
  | `large-v3` | 1× | 最佳 | ~3 GB |
  | `medium.en` | 約 2× | 尚可 | ~1.5 GB |

  改用其他模型時設定 `ASR_LIVE_MODEL` 即可，例如 `ASR_LIVE_MODEL=large-v3 docker compose up -d`。

- [ ] **4. 啟動服務**
  ```bash
  cd server
  docker compose up -d --build
  ```

- [ ] **5. 驗證健康檢查**
  ```bash
  curl http://localhost:8000/health
  ```
  應回傳 `status` 為 `ok` 的 JSON（此為 gateway 自身的檢查）。後端各實例的檢查見下方「雙實例部署」。

- [ ] **6. 驗證轉錄品質**
  以一段實際會議錄音呼叫轉錄端點，確認繁體中文台灣用語、語者標籤正確性，並記錄處理速度（RTF）與 VRAM 用量，作為調整 `ASR_COMPUTE_TYPE`、`ASR_BATCH_SIZE` 的依據。

> 模型權重與 Hugging Face 快取以 volume 掛載，重建容器不會重新下載。升級時重新執行 `docker compose up -d --build`，再以健康檢查確認狀態。

### 關於 image 大小與 CUDA 來源

image 約 12.8 GB，其中約 7.7 GB 為 Python 相依，最大宗是 torch wheel 自帶的 CUDA runtime（`site-packages/nvidia/*` 約 4.1 GB）與 torch 本身（約 1.7 GB）。

base image 使用純 `ubuntu:22.04` 而非 `nvidia/cuda:*-cudnn-runtime`：PyPI 的 torch wheel 已自帶完整 CUDA 與 cuDNN，與 base image 內建者重複，且實際載入的是前者——換言之厚重的 CUDA base image 從未被真正使用。改用純 Ubuntu 後 image 由 18.2 GB 降至 12.8 GB，已實測 `ctranslate2` 與 `torch` 皆能正常使用 GPU（`int8` 與 `float16` 皆驗證通過，含 pyannote VAD 路徑）。

兩點影響：

- GPU 存取改由 NVIDIA Container Toolkit 於執行期注入驅動，故步驟 1 的驗證仍是必要前提。
- **CUDA 版本完全由 torch wheel 決定**（目前為 cu128），升級 torch 等同升級 CUDA。若日後改以系統 CUDA 為準，需同時調整 base image 與 torch 的安裝索引。

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

## 雙實例部署（批次中文 ／ 即時英文）

批次會議逐字稿與即時字幕的最佳模型並不相同：Breeze-ASR-26 是台灣中文與中英混用的 fine-tune，**不適合英文影片**；而同尺寸下其速度與原版 Whisper 相當，故若要降低即時延遲，應調整模型尺寸與 `ASR_COMPUTE_TYPE`，而非更換 fine-tune。

`docker compose` 因此定義兩個 ASR 實例，**共用同一份 image 與同一套 `app.py`**，僅環境變數不同：

| 服務 | 用途 | 模型變數 | 語者分離 |
| --- | --- | --- | --- |
| `asr-batch` | 中文會議逐字稿 | `ASR_MODEL` | 使用 |
| `asr-live` | 英文即時字幕 | `ASR_LIVE_MODEL` | 不使用 |

`asr-live` 不啟用語者分離，故不會載入 pyannote 模型，VRAM 用量低於 `asr-batch`（模型皆為惰性載入）。

### 即時字幕的模型選擇

即時字幕的瓶頸是**延遲**而非絕對準確度——每數秒的音訊視窗都要在下一個視窗到來前完成轉錄。故預設採 `distil-large-v3`：Whisper large-v3 的英文蒸餾版，速度約 6 倍而英文品質接近原版。

| `ASR_LIVE_MODEL` | 相對速度 | 英文品質 | 下載大小 | 適用 |
| --- | --- | --- | --- | --- |
| `distil-large-v3`（預設） | 約 6× | 接近 large-v3 | ~1.5 GB | 一般情境；速度與品質平衡 |
| `large-v3` | 1× | 最佳 | ~3 GB | GPU 充裕、可接受較高延遲 |
| `medium.en` | 約 2× | 尚可 | ~1.5 GB | VRAM 吃緊 |

三者皆為 WhisperX 內建代號，**首次載入時自動下載，無須事先準備或轉檔**。

注意：`distil-large-v3` 與 `medium.en` 皆為**英文專用**，不適合中文或多語內容——即時字幕若要轉錄其他語言，應改用 `large-v3`。批次中文會議不受影響（走 `asr-batch` 的 Breeze-ASR-26）。

延遲仍不足時，優先調整 `ASR_COMPUTE_TYPE`（`int8` 較快、`float16` 較準）而非再換更小的模型。

### 為何用 gateway 而非各自開埠

兩個實例皆**不對外開埠**，一律經 `gateway`（nginx）於單一埠分流：

```
http://<host>:8000/live/...   ->  asr-live:8000
http://<host>:8000/...        ->  asr-batch:8000（預設路由）
```

**批次為預設路由**：不帶路徑前綴的請求一律轉給批次實例，故既有設定（如 `http://host:8000`）升級 gateway 後無須修改。`/batch` 前綴仍可使用，供明確指定時用。只有即時字幕需填 `/live`。

如此對外只佔用一個埠。兩者仍為獨立 process、各有各的序列化鎖，故長會議轉錄**不會**讓即時字幕排隊等待——但兩者同時執行時會爭用 GPU 算力，即時字幕的延遲仍會惡化，此為物理限制。

若改以「單一 process 依請求參數切換模型」實作，會因 `app.py` 的 ASR 模型為單一欄位且無卸載路徑，退化為兩個模型同時常駐（VRAM 與雙實例相同），卻多背共用鎖導致的排隊問題，故不採用。

### 端點對照

| 用途 | URL |
| --- | --- |
| 批次健康檢查（預設路由） | `http://<host>:8000/health` |
| 批次轉錄（預設路由） | `http://<host>:8000/v1/audio/transcriptions` |
| 批次健康檢查（明確前綴） | `http://<host>:8000/batch/health` |
| 即時健康檢查 | `http://<host>:8000/live/health` |
| 即時轉錄 | `http://<host>:8000/live/v1/audio/transcriptions` |
| gateway 自身存活檢查 | `http://<host>:8000/gateway-health` |

> `/health` 轉發至批次後端而非由 gateway 自行回答。這是刻意的：若 gateway 自答 `/health`，未帶前綴的設定會在「測試連線」時假性通過，實際打轉錄端點才失敗。要確認 gateway 本身是否就緒請用 `/gateway-health`。

### 只想跑單一實例

```bash
docker compose up -d --build asr-batch gateway
```

此時 `/live/` 路徑會回 502，`/batch/` 正常。

### 逾時設定

`nginx.conf` 的 `proxy_read_timeout` 對批次設為 3600 秒，須與客戶端的 `LOCAL_ASR_TIMEOUT_SECS` 一致——否則長錄音會在 gateway 這層先被切斷，客戶端只看到連線中斷而非真正原因。即時路徑設為 120 秒，僅作為兜底（首次請求需惰性載入模型），實際的即時節奏把關由客戶端自身的秒級逾時負責。

上傳大小上限為 2048 MB（`client_max_body_size`），長會議錄音可達數百 MB，預設的 1 MB 會被擋下。

## 環境變數

| 變數 | 說明 | 預設 |
| --- | --- | --- |
| `ASR_LIVE_MODEL` | 即時字幕實例的模型；WhisperX 代號（自動下載）或容器內路徑 | `distil-large-v3` |
| `ASR_LIVE_MODEL_PATH` | 即時字幕模型的 host 端目錄；僅在 `ASR_LIVE_MODEL` 指向本地目錄時需要 | `./models/asr-live-model` |
| `ASR_LIVE_BATCH_SIZE` | 即時字幕實例的批次大小；以延遲為先故預設較小 | `4` |
| `ASR_PORT` | gateway 對外埠 | `8000` |
| `ASR_MODEL` | ASR 模型：CTranslate2 目錄、HF repo 名稱，或 WhisperX 內建代號（如 `large-v3`）。相容別名 `BREEZE_MODEL_DIR` | `MediaTek-Research/Breeze-ASR-26` |
| `ASR_DEVICE` | 推論裝置 | `cuda` |
| `ASR_COMPUTE_TYPE` | 運算精度；VRAM 較小建議 `int8`，較充裕可用 `float16` | `int8` |
| `ASR_BATCH_SIZE` | 批次大小；VRAM 較小時調降 | `8` |
| `DIARIZATION_MODEL` | 語者分離模型（明確指定，不依賴 WhisperX 會變動的預設值） | `pyannote-community/speaker-diarization-community-1` |
| `DIARIZATION_CLUSTERING_THRESHOLD` | pyannote AHC 分群門檻（cosine 距離，範圍 0–2）；設為空字串則採模型預設值（`0.6`） | `1.0`（實測值） |
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

### 分群門檻

pyannote 以 AHC（凝聚式階層分群）依聲紋 embedding 的 cosine 距離決定講者身分。同一人在音量、語氣、麥克風距離變化，或長時間間隔後再發言時，embedding 距離可能超過分群門檻而未被合併，導致一人被判為多個講者；反之門檻太高則可能把不同人合併為同一講者。

`DIARIZATION_CLUSTERING_THRESHOLD` 可覆寫此門檻，範圍為 cosine 距離 0–2：

- **調低**：分群更嚴格，傾向將講者拆得更細（可能加劇「一人被拆成多人」）。
- **調高**：分群更寬鬆，傾向合併相近的聲紋（可能導致「不同人被合併」）。

`docker-compose.yml` 預設帶入 `1.0`（實測值，理由見下）。要改回模型預設值 `0.6`，於 `server/.env` 寫入空值即可：

```dotenv
DIARIZATION_CLUSTERING_THRESHOLD=
```

（compose 使用 `${VAR-1.0}` 單破折號語法，故 `.env` 中的空字串會照實傳入而不被預設值取代。）

取用底層 pyannote pipeline 參數失敗時（版本升級可能變動未公開介面），服務會記錄 log 並安全降級為模型預設值，不中斷轉錄。

#### 實測結果與建議值

以一段 43 分鐘、實際三人（主要為兩人對談）的中文會議錄音實測（`pyannote-community/speaker-diarization-community-1`，模型預設門檻為 `0.6`）：

| 門檻 | 分段數 | 講者分佈 | 判讀 |
| --- | --- | --- | --- |
| `0.6`（模型預設） | 522 | A:231、B:240、C:50 | 出現第三位講者 C，實為 A/B 被誤拆 |
| `0.8` | 514 | A:229、B:240、C:44 | 幾乎無改善，C 仍在 |
| **`1.0`（建議）** | 525 | A:260、B:264 | **C 消失，收斂為正確的兩人** |
| `1.2` | 91 | A:91 | 過度合併，全部併為同一人（等同未分離） |

**建議值為 `1.0`**：可有效消除「同一人被判為多個講者」，且尚未反向造成不同人被合併（`1.2` 才發生過度合併）。此為單一錄音的實測結果，不同錄音環境（麥克風距離、人數、環境噪音）的最佳值可能不同，建議以自身錄音比對後再定案。

需注意：**調高門檻只能解決分群階段的誤拆，無法消除字級切分本身的碎片化**。上表中 `0.6` 與 `1.0` 的分段數同為 5 百多段，因為分段數主要由字級講者標籤的跳動決定，而非講者總數；門檻影響的是「這些分段被歸給幾個講者」。

## app 端設定

在 VoxNote 的「設定 > 語音轉錄」選擇「VoxNote 轉錄服務」，Base URL 填入**含路徑前綴**的位址。設定頁的「測試連線」會呼叫該位址下的 `/health`。本服務預設無驗證機制，請部署於受信任的網路環境。

| 設定位置 | Base URL 範例 |
| --- | --- |
| 設定頁 > 批次逐字稿 | `http://192.168.0.10:8000`（不需前綴） |
| 即時字幕頁 > 遠端端點 | 可留空（見下方自動偵測） |

兩者為各自獨立的設定（即時字幕的來源語言與端點與批次流程分離）。

**即時字幕端點會自動偵測**：該欄位留空時，app 於**啟動 session 時探測一次** `{批次位址}/live/health`——

- 回應成功（gateway 雙實例部署）→ 本次 session 採用 `{批次位址}/live`，即英文模型實例
- 回應失敗（舊版單一容器部署，實測回 404）→ 沿用批次位址

探測僅在啟動時進行一次，session 期間不重複，故不影響即時字幕每個音訊視窗的延遲。

若欄位已填寫則**直接採用、不進行探測**——自動偵測是未設定時的預設行為，不覆蓋明確設定。需要指向其他主機或強制使用特定實例時填入完整位址即可。

> 未經 gateway 的舊部署（單一容器直接開埠）同樣不需前綴，設定完全相容。

### 低延遲增量端點

`POST /v1/audio/transcriptions/incremental` 是即時字幕專用端點，使用 multipart
上傳 `file`，可選 `language`，並直接以 faster-whisper 模型轉錄後回傳：

```json
{"text":"...","language":"en"}
```

此端點不建立背景任務、不執行 WhisperX 詞級對齊或 pyannote 語者分離，適合 app
以短於分析視窗的間隔重複送出重疊音訊。連續回應的 `text` 格式一致，LocalAgreement
由 VoxNote app 呼叫端負責判定暫定與確定文字。模型載入失敗會回傳 HTTP 503 與明確
錯誤，不會在服務內靜默改走批次端點。

批次端點 `POST /v1/audio/transcriptions` 與 `sync=true` 契約不變，仍使用 WhisperX
對齊與可選的語者分離。兩條路徑目前各自持有 faster-whisper/WhisperX 模型實例，
避免批次後處理阻塞低延遲請求；代價是需要較多 VRAM，部署時應依 GPU 餘裕調整模型
與 `ASR_INCREMENTAL_COMPUTE_TYPE`。

### 轉錄 API

`POST /v1/audio/transcriptions` 使用 multipart：`file` 為音訊檔；可選 `language`、`diarize`、`min_speakers` 與 `max_speakers`。預設為非同步模式，服務會立即回傳：

```json
{"task_id":"<uuid>","status":"queued","progress":0}
```

客戶端接著輪詢 `GET /v1/tasks/<task_id>`。任務狀態為 `queued`、`processing`、`done` 或 `failed`，`progress` 會依轉錄、對齊、語者分離三階段回報 `0`、`33`、`66`、`100`。完成時回應的 `result` 內容包含 `text`、`segments`、`language` 與 `diarization_enabled`；`segments` 含秒數 `start`、`end`、`text`，啟用語者分離時另含 `speaker`。失敗時回應 `error` 繁體中文錯誤訊息。

```json
{"task_id":"<uuid>","status":"done","progress":100,"result":{"text":"...","segments":[]}}
```

即時字幕可在同一個 multipart 請求加入 `sync=true`，直接取得上述 `result` 格式，不建立任務，也不經背景佇列。批次流程不要帶 `sync`，避免長音訊請求被同步等待。任務只保留一小時，或保留最多 1000 筆已完成任務；服務重啟後記憶體中的任務會清除。

gateway 的 `/batch/v1/tasks/<task_id>` 會依既有 `/batch/` 前綴轉發至批次實例，未帶前綴的 `/v1/tasks/<task_id>` 也會轉發至批次實例；兩者都是短輪詢請求，不會等待整段轉錄，因此不受批次長連線逾時影響。

## 小 VRAM 機器的冒煙測試

VRAM 較小（例如 8GB）的 GPU 可用於 API 冒煙測試，但不適合作為正式長會議服務。建議採較保守的設定：

1. 將 `ASR_COMPUTE_TYPE` 設為 `int8`，`ASR_BATCH_SIZE` 降為 1 至 2。
2. 先停用 `diarize`，確認基本轉錄後再啟用 pyannote；語者分離會增加 VRAM 與處理時間。
3. 若發生 CUDA 記憶體不足，縮短音檔、降低 batch size，或改用 CPU 模式驗證 API 契約。

完成冒煙測試後，仍須在具備足夠 VRAM 的正式部署機器上進行實際錄音的品質、RTF 與 VRAM 驗證。
