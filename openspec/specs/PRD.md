# VoxNote 產品需求文件（PRD）

**版本**：0.1.0  
**建立日期**：2026-04-29  
**狀態**：草稿

---

## 一、產品概述

VoxNote 是一款桌面端會議記錄應用程式，基於 x-meet 專案重構而成。  
採用 **Tauri 2.0 + Rust 後端 + TypeScript 前端**，目標是打造一個輕量、高效、可全本地端運行的會議輔助工具。

### 核心價值主張

| 面向 | 說明 |
|------|------|
| **本地優先** | 所有資料存於本機 SQLite，不強制依賴雲端服務 |
| **AI 加持** | 支援本地 Ollama 或雲端 AI 進行逐字稿校稿與會議摘要 |
| **輕量高效** | Tauri 架構，安裝包 <100MB，啟動 <2 秒 |
| **隱私安全** | 會議內容不需上傳到第三方伺服器（全本地模式） |

---

## 二、x-meet 現有功能分析

> 本節記錄 x-meet 的設計與功能，作為 VoxNote 重構的基線參考。

### 2.1 架構設計

**Electron 架構（x-meet）**

```
main.js（Electron 主進程）
  └── BrowserWindow → index.html / meeting.html / settings.html
      └── js/（前端 JS，直接跑在渲染進程）
          ├── db.js        Dexie IndexedDB 操作
          ├── app.js       首頁：會議列表、分類、匯入備份
          ├── record.js    錄音、上傳、AI 轉錄、校稿、摘要
          ├── meeting.js   會議詳情頁：渲染、匯出、版本切換
          ├── settings.js  設定頁：Provider 切換、連線測試
          ├── aiProvider.js AI 抽象層（Cloud / Ollama）
          └── ollamaManager.js Ollama API 封裝
```

**資料存儲**：Dexie（IndexedDB）
- 所有資料在瀏覽器 IndexedDB，無法獨立備份單一檔案
- 音訊以 Blob 存在 IndexedDB（不友好，有大小限制）

### 2.2 資料模型（x-meet v11 Schema）

| Table | 主要欄位 | 說明 |
|-------|---------|------|
| `meetings` | id, title, categoryId, createdAt, updatedAt | 會議主檔 |
| `participants` | id, meetingId, name | 參與者 |
| `transcripts` | id, meetingId, content, rawJson, originalContent, proofreadContent, activeVersion, proofreadProvider, proofreadAt | 逐字稿（含版本管理） |
| `summaries` | id, meetingId, content, provider, createdAt | 會議摘要 |
| `recordings` | id, meetingId, audio（Blob）, createdAt | 錄音音訊 |
| `settings` | 各 API Key、Provider 設定 | 全域設定 |
| `categories` | id, name（唯一） | 會議分類 |

### 2.3 現有功能清單

#### 📋 會議管理
- 新增會議（標題、分類、參與者）
- 會議列表（按建立時間降序，支援分類 Tab 篩選）
- 編輯會議（標題、分類、參與者）
- 刪除會議（連帶刪除關聯資料）
- ZIP 備份匯入（含音訊還原）

#### 🎙️ 錄音功能
- 開始/停止錄音（`MediaRecorder`）
- 麥克風確認 Modal（含音量視覺化、測試播放）
- 錄音後存為 Blob 至 IndexedDB
- 支援上傳既有音訊（`.wav/.mp3/.m4a/.ogg/.aac`，限 100MB）
- 音訊播放器（波形顯示、播放/暫停、下載）

#### 📝 語音轉文字（ASR）
- API：**AssemblyAI**（雲端為主）
  - 上傳 `POST /v2/upload` → 建立轉錄 `POST /v2/transcript` → 輪詢 `GET /v2/transcript/{id}`
- 語言：中文（`zh`），開啟講者識別（`speaker_labels: true`）
- 逐字稿格式：`MM:SS 講者X: 文字內容`
- 逐字稿前固定插入四段佔位文字（供使用者填入人名對應、名詞定義等）

#### 🔄 逐字稿版本管理
- 原始版（`originalContent`）：首次轉錄後建立，不可被自動覆蓋
- 校稿版（`proofreadContent`）：AI 校稿結果
- 當前顯示版（`activeVersion`）：`original` 或 `proofread`
- 版本切換 UI：顯示/切換/複製/還原兩版本
- **防呆機制**：校稿後若長度異常縮短（截斷檢查），自動保留但不套用校稿版

#### ✏️ AI 校稿
- Cloud 模式：Gemini API
- Ollama 模式：`POST /api/generate`
- Prompt 重點：
  - 修正同音字、漏字、多字、標點錯誤、贅字
  - 只輸出修正後全文，不含說明
- 結果驗證：比對長度 + 時間標記數量，異常時不自動套用

#### 📊 會議摘要
- Cloud 模式：Gemini（Prompt 極詳細）
- Ollama 模式：本地 LLM（Prompt 簡化版）
- 摘要格式：Markdown，要求保留時間戳 `MM:SS`
- 摘要內容包含：
  - 主要摘要
  - 奇特/無意義詞
  - 提到的對象
  - TODO 清單
  - 詳細內容摘要
  - 無結論內容
  - 矛盾內容
  - 專有名詞
- 顯示時：Markdown 渲染 + 時間戳可點擊跳轉音訊

#### 📤 匯出功能
- 逐字稿 TXT（原始版 / 校稿版，檔名標記）
- 摘要 Markdown（直接輸出 `.md` 內容）
- 摘要 PDF（`html2pdf`，渲染 DOM 後輸出）
- ZIP 完整備份（`meeting.json` + `meeting_audio.wav`）

#### ⚙️ 設定頁
| 模式 | 語音轉文字 | 摘要/校稿 |
|------|----------|---------|
| Cloud | AssemblyAI | Gemini |
| Hybrid | AssemblyAI | Ollama |
| Ollama | （建議雲端）| Ollama |

設定項目：API Key（AssemblyAI / Gemini）、Ollama Endpoint、模型選擇（ASR / LLM）

#### 🦙 Ollama 整合
- 預設 endpoint：`http://localhost:11434`
- 連線測試：`GET /api/version`
- 模型列表：`GET /api/tags`（自動分類 ASR / LLM）
- 推薦模型：顯示警告與建議

---

## 三、VoxNote 重構目標

### 3.1 架構調整

**Tauri 2.0 架構（VoxNote）**

```
src-tauri/（Rust 後端）
  ├── commands/    Tauri 命令層（前端 invoke 呼叫點）
  ├── db/          SQLite 資料層（sqlx）
  ├── audio/       音訊錄製、格式轉換
  ├── asr/         語音轉文字（AssemblyAI / 本地 Whisper）
  ├── ai/          AI 校稿、摘要（Ollama / Gemini）
  └── config/      應用設定管理

src/（TypeScript 前端）
  ├── pages/       各頁面模組
  ├── components/  共用 UI 元件
  ├── api/         Tauri invoke 封裝（型別安全）
  └── stores/      前端狀態管理
```

**資料存儲**：SQLite（檔案存儲，可直接備份）
**音訊存儲**：本機檔案系統（不塞進 DB）

### 3.2 功能調整清單

#### ✅ 保留（等同 x-meet）
- 會議 CRUD（標題、分類、參與者）
- 分類管理
- 逐字稿版本管理（original / proofread / activeVersion）
- AI 校稿（Ollama + Cloud）
- 會議摘要生成（Ollama + Cloud）
- 三種 Provider 模式（Cloud / Hybrid / Ollama）
- 摘要 Markdown 匯出
- 逐字稿 TXT 匯出
- PDF 匯出
- 完整備份與還原

#### 🔧 調整（優化 x-meet 缺陷）
| 功能 | x-meet 問題 | VoxNote 改善 |
|------|------------|-------------|
| 音訊存儲 | Blob 塞進 IndexedDB，有大小限制 | 改存本機檔案系統（`AppData/voxnote/recordings/`） |
| 設定存儲 | IndexedDB 難備份 | 改存 `config.toml`（可直接編輯/備份） |
| 資料備份 | 手動 ZIP 匯出 | 直接複製 SQLite 檔案即可備份 |
| ASR 輪詢 | 前端 JS 輪詢（頁面關閉即中斷） | 改為 Rust 後台輪詢（關窗不中斷） |
| 逐字稿格式 | 固定插入佔位文字（可能造成混淆） | 改為可選的「提示卡」UI，不污染逐字稿內容 |
| Ollama ASR | 實際上還是走雲端 | 明確標示；未來支援本地 Whisper |
| PDF 匯出 | html2pdf 版面不穩定 | 改用 Rust `printpdf` 或 Chromium headless |

#### 🆕 新增功能
| 功能 | 說明 | 優先級 |
|------|------|--------|
| **全本地 ASR（Whisper）** | 整合 `whisper.cpp`，不需 AssemblyAI | P1（核心目標） |
| **即時字幕生成** | 麥克風/系統音訊擷取 + 即時 Whisper | P2 |
| **字幕翻譯** | 逐字稿/字幕翻譯為其他語言（Ollama 翻譯） | P2 |
| **字幕自動校準** | 時間戳 + 文字對齊校正 | P2 |
| **系統聲音擷取** | Windows WASAPI / macOS Core Audio | P2 |
| **多語言支援** | 介面 i18n（繁中/英） | P3 |
| **會議搜尋** | 全文搜尋（SQLite FTS5） | P3 |
| **快捷鍵** | 全域快捷鍵（錄音開始/停止） | P3 |

---

## 四、功能需求詳細規格

### 4.1 會議管理

#### FR-001 新增會議
- **輸入**：標題（必填）、分類（可選）、參與者（可選，多人）
- **行為**：建立 meeting 記錄，導向會議詳情頁
- **驗證**：標題不可為空，最多 200 字元

#### FR-002 會議列表
- **顯示**：依建立時間降序排列
- **篩選**：分類 Tab，預設顯示「全部」
- **資訊**：標題、建立日期、分類標籤、狀態（有無逐字稿/摘要）

#### FR-003 刪除會議
- **確認**：刪除前顯示確認對話框
- **聯動刪除**：刪除關聯的 participants、transcripts、summaries
- **音訊**：標記刪除（不立即刪除檔案，可由設定設定保留天數）

#### FR-004 分類管理
- 新增/編輯/刪除分類
- 分類名稱唯一
- 刪除分類不刪除該分類下的會議（改為「未分類」）

### 4.2 錄音功能

#### FR-010 麥克風錄音
- **開始前**：顯示麥克風選擇 + 音量測試 Modal
- **錄音中**：即時音量視覺化（波形）、計時器
- **停止後**：音訊存本機檔案（`.wav`），更新 recording 記錄的檔案路徑

#### FR-011 音訊上傳
- **支援格式**：`.wav`, `.mp3`, `.m4a`, `.ogg`, `.aac`, `.flac`
- **大小限制**：500MB（調高，Rust 可處理大檔）
- **行為**：複製到 `AppData/voxnote/recordings/` 並建立 recording 記錄

#### FR-012 音訊播放
- 播放/暫停/拖曳進度條
- 顯示時間戳（與逐字稿時間戳同步高亮）
- 點擊逐字稿時間戳跳轉播放位置

#### FR-013 系統音訊擷取（P2）
- Windows：WASAPI loopback
- macOS：Core Audio（需注意沙盒限制）
- 可同時擷取麥克風 + 系統音訊並混音

### 4.3 語音轉文字（ASR）

#### FR-020 雲端 ASR（AssemblyAI）
- 上傳音訊 → 建立轉錄任務 → **背景輪詢**（Rust 背景任務，關閉視窗不中斷）
- 完成後通知前端更新
- 語言：自動偵測或指定（中文 `zh`）
- 開啟講者識別

#### FR-021 本地 ASR（Whisper.cpp）（P1）
- 整合 `whisper-rs`（Rust binding）
- 模型管理：自動下載 / 手動匯入（`tiny` / `base` / `small` / `medium`）
- 進度顯示：百分比 + 剩餘時間估算
- 完全離線，不需網路

#### FR-022 逐字稿格式
- 格式：`[MM:SS] 講者A: 文字內容`
- 講者對應：提供 UI 讓使用者設定「講者 A → 實際人名」
- 不在逐字稿內容中插入佔位文字（改為獨立 UI 欄位）

### 4.4 逐字稿版本管理

#### FR-030 版本儲存
- `original_content`：首次 ASR 結果，**不可覆蓋**
- `proofread_content`：最新 AI 校稿結果（可多次更新）
- `active_version`：`original` | `proofread`

#### FR-031 版本切換
- UI 提供「原始版 / 校稿版」切換按鈕
- 切換時若無校稿版，顯示提示而非報錯

#### FR-032 截斷防呆
- 校稿後比對：字數比例 + 時間戳數量
- 若校稿後字數 < 原始 60% 或時間戳數量 < 原始 70%，則：
  - 保存校稿版但顯示警告
  - 不自動切換 `active_version`
  - 顯示「校稿結果異常，請手動確認」

### 4.5 AI 校稿

#### FR-040 校稿觸發
- 手動觸發（按鈕），不自動執行
- 顯示進度（Ollama streaming 支援）

#### FR-041 校稿 Prompt（可設定）
```
你是一位專業的中文會議記錄校對員。
請校正以下逐字稿中的錯字（同音字、漏字、多字、標點錯誤）。
保留所有時間標記 [MM:SS] 不得刪除或修改。
保留所有講者標記不得刪除。
只輸出修正後的完整逐字稿，不要加任何說明或前後文。

逐字稿內容：
{transcript}
```

#### FR-042 模型支援
- Cloud：Gemini 1.5 Pro / 2.0
- Local：任何 Ollama 相容模型（使用者自選）

### 4.6 會議摘要

#### FR-050 摘要生成
- 手動觸發
- 輸入：逐字稿 `active_version` 的內容
- 輸出：Markdown 格式

#### FR-051 摘要結構（預設 Prompt 產出）
```
## 會議摘要
## 參與人員
## 主要議題
## 決議事項
## 待辦事項（TODO）
## 重要時間點（含 MM:SS 連結）
## 專有名詞說明
```

#### FR-052 摘要自訂 Prompt（P2）
- 使用者可自訂 Prompt 模板
- 支援變數：`{transcript}`, `{participants}`, `{meeting_title}`

### 4.7 匯出功能

#### FR-060 逐字稿匯出
- TXT：純文字，含版本標記（原始版 / 校稿版）
- SRT：字幕格式（P2，需要精確時間戳）

#### FR-061 摘要匯出
- Markdown（`.md`）
- PDF（使用 Rust 生成，穩定版面）

#### FR-062 完整備份
- 匯出：SQLite 資料庫 + 錄音檔（ZIP）
- 匯入：解壓縮後還原，支援合併或覆蓋模式

### 4.8 設定管理

#### FR-070 Provider 模式
| 模式 | ASR | 摘要/校稿 |
|------|-----|---------|
| Cloud | AssemblyAI | Gemini |
| Hybrid | AssemblyAI | Ollama |
| Ollama | Whisper.cpp（P1）| Ollama |
| Full Local | Whisper.cpp | Ollama |

#### FR-071 設定項目
**Cloud**
- AssemblyAI API Key
- Gemini API Key + 模型選擇

**Ollama**
- Endpoint（預設 `http://localhost:11434`）
- LLM 模型選擇（從 `/api/tags` 動態載入）
- Whisper 模型選擇（tiny / base / small / medium）

**應用設定**
- 錄音儲存路徑
- 音訊格式（WAV / MP3）
- 刪除錄音後保留天數
- 介面語言（P3）

#### FR-072 Ollama 連線測試
- 測試按鈕：連線成功顯示版本號，失敗顯示錯誤原因
- 自動載入可用模型清單
- 顯示推薦模型（依功能分類）

---

## 五、非功能需求

### 5.1 效能需求
| 指標 | 目標 |
|------|------|
| 應用啟動時間 | < 2 秒 |
| 開發模式 Vite 暖機回應 | `@vite/client` < 1 秒；超過 5 秒視為 watcher 退化 |
| 安裝包大小 | < 100MB |
| 記憶體占用（idle）| < 150MB |
| 逐字稿載入（1小時會議）| < 1 秒 |
| 本地 ASR（1小時，medium 模型）| < 10 分鐘 |

開發模式的 Vite watcher 僅可監看前端 HMR 所需檔案，必須排除 Rust 建置產物、Python 虛擬環境、ASR 模型／快取、OpenSpec artifacts 與代理工具設定目錄。詳細需求與診斷基準見 `development-environment-performance` capability。

### 5.2 安全性需求
- API Key 存儲：使用系統 Keychain（`tauri-plugin-stronghold` 或 OS Keychain）
- 音訊檔案：存本機，不上傳雲端（除 AssemblyAI 模式）
- 資料庫加密：可選（P3）

### 5.3 相容性需求
- **Windows**：10 / 11（x64）
- **macOS**：12+ (Apple Silicon + Intel)
- **最小螢幕解析度**：1280×720

### 5.4 可靠性需求
- ASR 背景任務：關閉視窗後繼續輪詢，完成後通知
- 錄音中斷處理：意外關閉時自動保存已錄內容
- 資料庫：事務性寫入，避免資料不一致

---

## 六、技術架構規格

### 6.1 Rust 後端依賴（src-tauri）

```toml
[dependencies]
tauri = { version = "2", features = ["macos-private-api"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
sqlx = { version = "0.7", features = ["sqlite", "runtime-tokio", "migrate"] }
reqwest = { version = "0.11", features = ["json", "multipart", "stream"] }
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-notification = "2"
```

### 6.2 前端依賴（package.json）

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@tauri-apps/plugin-fs": "^2"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "vite": "^6",
    "typescript": "~5.6"
  }
}
```

### 6.3 SQLite Schema（VoxNote）

```sql
-- 會議
CREATE TABLE meetings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 分類
CREATE TABLE categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 參與者
CREATE TABLE participants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    name       TEXT NOT NULL
);

-- 逐字稿
CREATE TABLE transcripts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id        INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    original_content  TEXT,
    proofread_content TEXT,
    active_version    TEXT NOT NULL DEFAULT 'original' CHECK (active_version IN ('original', 'proofread')),
    raw_json          TEXT,
    proofread_provider TEXT,
    proofread_at      DATETIME,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 摘要
CREATE TABLE summaries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    provider   TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 錄音（存路徑，不存 Blob）
CREATE TABLE recordings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    file_path   TEXT NOT NULL,
    duration_ms INTEGER,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 講者對應
CREATE TABLE speaker_mappings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    speaker_id TEXT NOT NULL,
    name       TEXT NOT NULL
);
```

---

## 七、開發優先級

### P0（MVP）
- [ ] 專案骨架與資料層（SQLite + Tauri 命令）
- [ ] 會議 CRUD
- [ ] 音訊上傳 + 播放
- [ ] AssemblyAI 雲端 ASR（背景輪詢）
- [ ] 逐字稿版本管理（original / proofread）
- [ ] Ollama 摘要生成
- [ ] Gemini 摘要生成
- [ ] 逐字稿 TXT 匯出
- [ ] 摘要 Markdown 匯出

### P1（功能完整）
- [ ] 本地 Whisper.cpp ASR
- [ ] AI 校稿（含截斷防呆）
- [ ] PDF 匯出（Rust 生成）
- [ ] ZIP 備份/還原
- [ ] 設定頁完整實作

### P2（功能增強）
- [ ] 即時字幕（系統音訊 + 麥克風）
- [ ] 字幕翻譯
- [ ] 自訂摘要 Prompt
- [ ] SRT 字幕匯出
- [ ] 全文搜尋

### P3（長期規劃）
- [ ] 多語言介面（i18n）
- [ ] 全域快捷鍵
- [ ] 資料庫加密
- [ ] 雲端同步（可選）

---

## 八、待討論事項

1. **Whisper 模型管理**：首次使用自動下載 vs 手動放置模型檔？
2. **音訊存放路徑**：固定 `AppData` vs 使用者自訂路徑？
3. **API Key 安全存儲**：使用 OS Keychain 還是簡單加密 config 檔案？
4. **字幕功能的優先級**：是否在 MVP 後就立即開始 P2？
5. **麥克風 + 系統音訊混音**：是否需要分軌儲存？

---

_文件最後更新：2026-04-29_
