<h1 align="center">
  VoxNote
</h1>

<p align="center">
  <strong>本地優先的 AI 會議助理</strong><br>
  錄音 · 語音轉文字 · AI 校對 · 智慧摘要
</p>

<p align="center">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2.0-blue?logo=tauri">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-1.80+-orange?logo=rust">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.6-blue?logo=typescript">
  <img alt="License" src="https://img.shields.io/badge/License-MIT-green">
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS-lightgrey">
</p>

<p align="center">
  中文版 | <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img alt="VoxNote 應用程式截圖" src="./screenshot.png" width="960">
</p>

---

## 目錄

- [簡介](#簡介)
- [功能特色](#功能特色)
- [技術架構](#技術架構)
- [系統需求](#系統需求)
- [快速開始](#快速開始)
- [AI 供應商設定](#ai-供應商設定)
- [ASR 語音辨識設定](#asr-語音辨識設定)
- [即時字幕](#即時字幕)
- [貢獻指南](#貢獻指南)
- [授權條款](#授權條款)

---

## 簡介

VoxNote 是一款以**本地優先**設計的桌面會議助理。所有資料儲存於本機 SQLite，錄音檔案存放於本地磁碟，無強制雲端依賴。

支援使用 **AssemblyAI**（雲端）或 **Whisper**（本地）進行語音轉文字，並整合多種 LLM 提供商（OpenAI、Claude、Gemini、Ollama、OpenRouter 等）進行 AI 校對與摘要生成。

```
會議錄音 → 語音轉文字 → AI 校對 → 智慧摘要 → 匯出
```

---

## 功能特色

### 會議管理

- 建立、編輯、刪除會議，支援分類與標籤
- 參與者管理（含常用參與者快速選取）
- 會議模板（預設標題、分類、參與者）

### 錄音功能

- 桌面錄音流程，支援停止後預覽再儲存
- 關閉主視窗時會先完成進行中的字幕與錄音收尾，再結束應用程式
- Windows 支援「僅麥克風 / 僅電腦音訊 / 麥克風 + 電腦音訊混音」錄音
- 支援上傳音訊檔案（`.wav` / `.mp3` / `.m4a` / `.ogg` / `.aac` / `.flac`，最大 500MB）
- 自訂音訊播放器（播放/暫停、進度條、靜音）

> 電腦本地音訊錄音目前以 Windows 為優先支援平台，會擷取系統預設播放裝置的聲音。

### 即時字幕

- 以滑動音訊視窗逐段產生字幕，不必等待整段音訊結束
- 支援電腦系統音訊與麥克風來源，系統音訊擷取僅支援 Windows
- 可選擇行程內本地 Whisper 或 VoxNote 自架 ASR 服務
- 可將字幕翻譯成繁體中文台灣用語，並以獨立永遠置頂的浮動視窗顯示
- 字幕僅存在於即時 session，不寫入資料庫、不產生錄音檔、不提供語者分離

### 語音轉文字（ASR）

- **AssemblyAI**（雲端）：自動語言偵測、說話者分離
- **VoxNote 自架 ASR 轉錄服務**：結合 Breeze-ASR-26 與 WhisperX 的自架轉錄端點（需 NVIDIA GPU）
- **本地 Whisper**：偵測 PATH 中的 `whisper`、`faster-whisper`、`openai-whisper`

### AI 校對

- 修正錯字、同音異字、標點錯誤
- 保留原始時間戳記（`[MM:SS]`）
- 自動偵測縮略品質，不符標準時提示確認
- 保存原始版本與校對版本，可隨時切換

### AI 摘要

- 生成結構化 Markdown 摘要（主題、待辦事項、重要時間點等）
- 支援自訂 Prompt

### 匯出

- 整包會議匯出：逐字稿、摘要、音訊一站式打包
- 逐字稿 TXT（原始版 / 校對版）
- 摘要 Markdown

### UI 設計

- 全新暖色調檔案館風格主題
- 垂直單欄會議列表佈局，強調視覺層級
- 純文字符號導航列，優化可讀性

---

## 技術架構

| 層次     | 技術                                                         |
| -------- | ------------------------------------------------------------ |
| 桌面框架 | [Tauri 2.0](https://tauri.app/)                              |
| 後端     | Rust + [sqlx](https://github.com/launchbadge/sqlx)（SQLite） |
| 前端     | Vanilla TypeScript + [Vite](https://vitejs.dev/)             |
| AI 呼叫  | reqwest（HTTP）— 無第三方 AI SDK                             |
| 設定儲存 | TOML（`AppData` 目錄）                                       |

```
src/                    # 前端（Vanilla TypeScript）
├── api/                # Tauri invoke 封裝層
├── components/         # DOM 元件
├── pages/              # 頁面渲染（Hash Router）
└── types/index.ts      # 全域型別定義

src-tauri/src/          # Rust 後端
├── commands/           # Tauri IPC handlers
├── db/                 # SQLite CRUD + migration
├── ai/                 # LLM 統一呼叫入口（call_llm）
├── asr/                # 語音辨識（AssemblyAI + 自架服務 + 本地 Whisper）
├── live_caption/       # 即時字幕 session、分段轉錄與事件推送
└── config/             # AppConfig 讀寫
```

---

## 系統需求

### 執行環境

- **Windows** 10 / 11（x64）
- **macOS** 12+（Apple Silicon 或 Intel）

### 開發環境

- [Node.js](https://nodejs.org/) 18+（或 [Bun](https://bun.sh/)）
- [Rust](https://rustup.rs/) 1.80+（含 `cargo`）
- [Tauri CLI v2](https://tauri.app/start/)

Windows 額外需要（C++ Build Tools）：

```
winget install Microsoft.VisualStudio.2022.BuildTools
```

即時字幕的行程內本地 Whisper 另外需要 LLVM（含 `libclang`）與 CMake，兩者是
`whisper-rs-sys` 建置所需。若要啟用 CUDA GPU 加速，還需要 CUDA Toolkit 12.8
或更新版本；預設建置不包含 CUDA，避免沒有 CUDA 的環境無法編譯或執行。

```bash
# 確認基本工具
cmake --version

# CPU 版本（預設）
cargo build --manifest-path src-tauri/Cargo.toml

# 選用：CUDA GPU 版本
cargo build --manifest-path src-tauri/Cargo.toml --features live-caption-cuda
```

若編譯時 cmake 找不到目標顯卡的 CUDA 架構（例如新款顯卡未被預設架構清單涵蓋），
需另外指定 `CMAKE_CUDA_ARCHITECTURES` 環境變數。可用 `nvidia-smi --query-gpu=compute_cap --format=csv`
查詢顯卡的 compute capability（例如 `12.0` 對應 `120`）。

打包 CUDA 版安裝檔請用：

```bash
bun run tauri:build:cuda
```

此指令固定以 `CMAKE_CUDA_ARCHITECTURES=120`（RTX 50 系列 / sm_120）建置；
若目標顯卡架構不同，需修改 `package.json` 中 `tauri:build:cuda` script 的對應值。
安裝完成後的應用程式名稱與 CPU 版相同（皆為 `VoxNote`），僅安裝檔檔名會加上
`-CUDA` 後綴以便區分（如 `VoxNote-CUDA_x.x.x_x64-setup.exe`），
與一般 CPU 版（`VoxNote_x.x.x_x64-setup.exe`）不會互相覆蓋建置產物。
由於兩者的應用程式識別碼相同，同一台機器只能安裝其中一個版本，
安裝其中一版會覆蓋另一版。

---

## 快速開始

### 1. 複製專案

```bash
git clone https://github.com/chinglee17/voxnote.git
cd voxnote
```

### 2. 安裝前端相依套件

```bash
npm install
# 或使用 bun
bun install
```

### 3. 開發模式

```bash
# 僅啟動 Vite 前端（port 1420）
npm run dev

# 啟動完整 Tauri 應用（含 Rust 後端，首次編譯約 2-5 分鐘）
npm run tauri dev
```

### 4. 建置發行版

```bash
npm run tauri build
```

產出物位於 `src-tauri/target/release/bundle/`。

---

## AI 供應商設定

啟動應用後，前往「設定」頁面設定 AI 供應商。

### 支援的 LLM 供應商

| 供應商         | 需要 API Key | 說明                                             |
| -------------- | ------------ | ------------------------------------------------ |
| **OpenAI**     | 是           | GPT-4o 等                                        |
| **Claude**     | 是           | Anthropic Claude 系列                            |
| **Gemini**     | 是           | Google Gemini 系列                               |
| **OpenRouter** | 是           | 多模型代理                                       |
| **Ollama**     | 否           | 本地 LLM，需先[安裝 Ollama](https://ollama.com/) |
| **自訂端點**   | 可選         | 任何 OpenAI 相容 API                             |

### Ollama 快速設定

```bash
# 安裝並執行 Ollama
ollama serve

# 拉取模型（範例）
ollama pull llama3.2
ollama pull qwen2.5
```

在 VoxNote 設定中填入 Endpoint `http://localhost:11434` 並選擇模型即可。

---

## ASR 語音辨識設定

### AssemblyAI（雲端）

1. 前往 [AssemblyAI](https://www.assemblyai.com/) 申請 API Key（有免費額度）
2. 在 VoxNote 設定 → ASR 供應商選「AssemblyAI」，填入 API Key

### VoxNote 自架 ASR 轉錄服務

位於 `server/`，以 **Breeze-ASR-26**（繁體中文台灣用語最佳）搭配 **WhisperX**（詞級對齊與語者分離）提供 OpenAI 相容的轉錄端點，供自有環境部署。

> **狀態**：API、Docker 與部署契約已完成，尚未在具備 GPU 的機器上實機驗證轉錄品質與效能。

#### 前置需求

- 具備 **NVIDIA GPU** 的機器（含 Driver、Docker Engine、NVIDIA Container Toolkit）
- Hugging Face access token（啟用語者分離時所需）
- 將 Breeze-ASR-26 權重轉為 CTranslate2 格式（約 6GB）

#### 啟動

```bash
cd server
docker compose up -d --build
curl http://localhost:8000/health
```

完整部署步驟（模型轉檔、pyannote 授權、環境變數、小 VRAM 機器調校）詳見 **[server/README.md](./server/README.md)**。

#### app 端設定

設定 → 語音轉錄 → 選擇「VoxNote 轉錄服務」，Base URL 填入服務位址（例如 `http://192.168.0.10:8000`）。

> 本服務預設無驗證機制，請部署於受信任的網路環境。

### 本地 Whisper

安裝以下任一工具並確保在系統 `PATH` 中可被呼叫：

```bash
# 選項 A：openai-whisper（Python）
pip install openai-whisper

# 選項 B：faster-whisper（較快）
pip install faster-whisper

# 選項 C：whisper.cpp（C++，效能最佳）
# 詳見 https://github.com/ggml-org/whisper.cpp
```

VoxNote 啟動時會自動偵測已安裝的工具，在設定頁面中選取即可。

---

## 即時字幕

即時字幕使用 `whisper-rs` 在應用程式內載入 GGML 模型，不使用外部
`whisper` 執行檔，也不會將選用本地 Whisper 的音訊送往外部服務。

### 下載模型

請自行下載 Whisper GGML `.bin` 模型，建議先使用 `small`；若硬體記憶體足夠再使用
`medium`。模型下載完成後，前往「設定」→「即時字幕」→「GGML 模型檔」選取檔案。

模型檔可從 [whisper.cpp models](https://huggingface.co/ggerganov/whisper.cpp) 取得，
例如 `ggml-small.bin` 或 `ggml-medium.bin`。模型權重不應提交至 Git 儲存庫。

### 使用方式

1. 在「設定」→「即時字幕」選擇轉錄後端、音訊來源、視窗長度與顯示模式。
2. 開啟左側「即時字幕」頁面並按下「開始即時字幕」。
3. 將出現的無邊框字幕視窗拖曳到影片或會議視窗上方；右下角控制點可調整大小。
4. 即時字幕與一般桌面錄音互斥，停止其中一個後才能啟動另一個。

翻譯功能會逐段呼叫目前的 LLM 設定。長時間使用雲端 LLM 可能累積費用；本地
Ollama 翻譯與 Whisper 會共用系統記憶體／GPU VRAM，請避免同時載入過大的模型。

### 即時字幕與批次逐字稿為獨立設定

即時字幕的來源語言、遠端 ASR 端點與逾時秒數（「即時字幕」頁）與批次逐字稿的
對應設定（「設定」頁）彼此獨立，互不共用：

| 設定項 | 批次逐字稿 | 即時字幕 |
| --- | --- | --- |
| 來源語言 | `asr_language`（設定頁） | `live_caption_language`（即時字幕頁，預設 `auto`） |
| 自架 ASR 端點 | `local_asr_base_url`（設定頁） | `live_caption_remote_base_url`（即時字幕頁；留空則回退沿用批次端點） |
| 逾時策略 | 分鐘級（配合長錄音處理） | 秒級（`live_caption_remote_timeout_seconds`，預設 8 秒，避免卡住後續視窗） |

此設計對應兩種典型情境可能同時存在、且語言相反的使用方式：

- **批次中文會議**：以中文錄音檔跑批次逐字稿，`asr_language` 設為 `zh`。
- **即時英文影片字幕**：即時字幕來源語言另設為 `en`（或 `auto`），指向另一個
  以英文低延遲模型部署的自架 ASR 端點，與批次流程使用的中文模型分開。

若僅部署單一自架 ASR 服務且兩種情境的語言相同，可將即時字幕端點留空，
系統會自動回退沿用批次端點；`server/README.md` 另說明雙實例（批次／即時）
部署的 gateway 分流方式。

---

## 貢獻指南

歡迎提交 Issue 與 Pull Request。

### 開發規範

- Rust 錯誤處理：使用 `?` 或 `anyhow`，禁止 `.unwrap()`
- 新增後端功能：在 `src-tauri/src/commands/` 新增 command，並在 `src-tauri/src/lib.rs` 注册
- 新增前端 API 呼叫：在 `src/api/` 對應檔案封裝，禁止在頁面 / 元件直接呼叫 `invoke()`
- DB schema 變更：使用 `ALTER TABLE`（向下相容），禁止刪除現有欄位
- 主鍵一律使用 UUID v4 字串

### 分支命名

```
feature/功能名稱
fix/問題描述
```

### 推薦 IDE

[VS Code](https://code.visualstudio.com/) +
[Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) +
[rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

---

## 授權條款

[MIT License](LICENSE)

---

<p align="center">本專案使用 <a href="https://tauri.app/">Tauri</a> 建置</p>
