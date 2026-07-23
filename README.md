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
- Windows 支援「僅麥克風 / 僅電腦音訊 / 麥克風 + 電腦音訊混音」錄音
- 支援上傳音訊檔案（`.wav` / `.mp3` / `.m4a` / `.ogg` / `.aac` / `.flac`，最大 500MB）
- 自訂音訊播放器（播放/暫停、進度條、靜音）

> 電腦本地音訊錄音目前以 Windows 為優先支援平台，會擷取系統預設播放裝置的聲音。

### 語音轉文字（ASR）

- **AssemblyAI**（雲端）：自動語言偵測、說話者分離
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

- 逐字稿 TXT（原始版 / 校對版）
- 摘要 Markdown

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
├── asr/                # 語音辨識（AssemblyAI + 本地 Whisper）
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
