# PROJECT KNOWLEDGE BASE

**Generated:** 2026-04-30
**Branch:** main

## OVERVIEW

VoxNote 是 Tauri 2.0 桌面應用程式，提供會議錄音、語音轉文字（ASR）、AI 摘要/校對功能。前端為 Vanilla TypeScript + Vite（無框架），後端為 Rust + SQLite（sqlx）。

## STRUCTURE

```
voxnote/
├── src/               # 前端 TS（Vanilla，無 React/Vue）
│   ├── api/           # Tauri invoke 封裝層（對應後端 commands）
│   ├── components/    # DOM 操作元件（非元件框架）
│   ├── pages/         # 頁面渲染函式（hash router）
│   └── types/         # 全域型別定義（index.ts）
├── src-tauri/         # Rust 後端
│   └── src/
│       ├── commands/  # Tauri IPC handler（#[tauri::command]）
│       ├── db/        # SQLite CRUD + migration（sqlx）
│       ├── ai/        # LLM 呼叫（OpenAI/Claude/Gemini/Ollama/custom）
│       ├── asr/       # 語音辨識（AssemblyAI + 本地 whisper）
│       └── config/    # AppConfig 讀寫（toml）
├── openspec/          # 產品規格文件（PRD.md 等）
└── dist/              # Vite 建置輸出（勿手動修改）
```

## WHERE TO LOOK

| 任務 | 位置 | 備註 |
|------|------|------|
| 新增 API 功能 | `src-tauri/src/commands/` + `src/api/` | 後端新增 command，前端新增 invoke wrapper |
| 資料庫 schema 變更 | `src-tauri/src/db/mod.rs` | migration 以 `ALTER TABLE` 方式向下相容 |
| 新增資料模型 | `src-tauri/src/db/models.rs` + `src/types/index.ts` | Rust struct 與 TS interface 須同步 |
| 頁面路由 | `src/main.ts` | hash-based router，`#page/id` 格式 |
| LLM 整合 | `src-tauri/src/ai/mod.rs` | 統一 `call_llm()` 入口 |
| ASR 整合 | `src-tauri/src/asr/mod.rs` | AssemblyAI + 本地 whisper |
| 設定值 | `src-tauri/src/config/mod.rs` | toml 序列化，對應 `AppConfig` struct |
| 產品需求 | `openspec/specs/PRD.md` | |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `run()` | fn | `src-tauri/src/lib.rs` | Tauri app 入口，注册所有 command |
| `init_db()` | fn | `src-tauri/src/db/mod.rs` | SQLite 連線 + migration |
| `call_llm()` | fn | `src-tauri/src/ai/mod.rs` | 統一 LLM 呼叫，支援 6 種 provider |
| `AppConfig` | struct | `src-tauri/src/config/mod.rs` | ASR + LLM 設定 |
| `MeetingWithDetails` | struct | `src-tauri/src/db/models.rs` | 含 tags/participants 的聚合查詢結果 |
| `parseRoute()` | fn | `src/main.ts` | hash router 解析 |
| `AppConfig` | interface | `src/types/index.ts` | 前端設定型別（與 Rust struct 對應） |

## CONVENTIONS

- **無測試**：目前無任何測試檔案或測試腳本，勿假設存在測試覆蓋
- **DB migration**：schema 變更用 `ALTER TABLE`（向下相容），不可刪除現有欄位；初始 schema 在 `MIGRATION_SQL` 常數中
- **IDs**：所有主鍵為 UUID v4 字串（`uuid` crate），非自增整數
- **時間欄位**：儲存為 ISO 8601 文字字串（`chrono`），非 timestamp integer
- **前端路由**：`#page` 或 `#page/id`，由 `hashchange` 事件驅動，無第三方 router
- **前端狀態**：純 TypeScript 物件（如 `RecordingState`），無狀態管理函式庫
- **Tauri invoke**：前端透過 `src/api/*.ts` 呼叫後端，直接 `invoke()` 而非 HTTP fetch

## ANTI-PATTERNS (THIS PROJECT)

- 勿在 `main.rs` 第一行的 `#![cfg_attr(...)]` 前加其他程式碼（Windows 必要設定）
- 勿在前端引入 React/Vue/任何 UI 框架（專案為 Vanilla TS）
- 勿用自增整數作為主鍵（一律 UUID v4）
- 勿直接在元件/頁面中呼叫 `invoke()`（須透過 `src/api/` 封裝）
- 勿破壞性修改 DB schema（只可新增欄位，不可刪除或修改型別）
- 勿使用 `unwrap()` 處理可能失敗的操作（用 `?` 或 `anyhow`）

## COMMANDS

```bash
# 前端開發（Vite dev server）
npm run dev        # port 1420, HMR on 1421

# 完整 Tauri 開發（含 Rust）
npm run tauri dev

# 建置
npm run build      # tsc + vite build
npm run tauri build

# 無測試腳本
```

## NOTES

- `src-tauri/target/` 為 Rust 編譯快取，**不入版控**，首次建置耗時長
- LLM 雲端 timeout 120s，本地（Ollama/custom）600s
- ASR 本地偵測：掃描 PATH 中的 `whisper`、`faster-whisper`、`openai-whisper`
- `recordings` 表有兩個後來 `ALTER TABLE` 新增的欄位：`sort_order`、`segment_transcript`
- 設定存於 Tauri AppData 目錄下（OS 相依路徑），非專案目錄
- Bun 作為套件管理器（`bun.lock`），但 npm scripts 同樣有效
