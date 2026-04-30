# RUST BACKEND

## OVERVIEW
Tauri 2.0 Rust 後端。`lib.rs` 為唯一入口，所有模組在此注册。

## STRUCTURE
```
src-tauri/src/
├── lib.rs        # run() — Tauri builder + plugin + invoke_handler 注册
├── main.rs       # main() — 僅呼叫 voxnote_lib::run()（勿改動）
├── commands/     # Tauri IPC handlers（#[tauri::command]）
├── db/           # SQLite CRUD + models + migration
├── ai/           # LLM 統一呼叫層
├── asr/          # 語音辨識（AssemblyAI + 本地 whisper）
└── config/       # AppConfig toml 讀寫
```

## WHERE TO LOOK

| 任務 | 位置 |
|------|------|
| 新增 IPC command | `commands/` 新增 fn + 在 `lib.rs` invoke_handler 注册 |
| 修改資料模型 | `db/models.rs` + 同步 `src/types/index.ts` |
| 新增 DB 欄位 | `db/mod.rs` MIGRATION_SQL ALTER TABLE 段落 |
| 修改 LLM 行為 | `ai/mod.rs` 的 `call_llm()` |
| 修改 ASR 行為 | `asr/mod.rs` |
| 讀寫設定 | `config/mod.rs` AppConfig struct |

## CONVENTIONS

- Rust 錯誤：一律用 `?` 或 `anyhow`，禁止 `unwrap()`
- `main.rs` 第一行必須保留 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
- 所有 command 函式接收 `State<SqlitePool>` 而非重建連線

## ANTI-PATTERNS

- 勿在 `main.rs` 第一行前加任何程式碼
- 勿在 commands/ 直接操作 DB（透過 db/ 模組函式）
- 勿新增自增整數 PK（UUID v4）
