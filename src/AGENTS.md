# FRONTEND SOURCE

## OVERVIEW
Vanilla TypeScript 前端，無框架。hash router 驅動，DOM 直接操作。

## STRUCTURE
```
src/
├── main.ts          # 應用入口 + hash router（parseRoute / renderPage）
├── styles.css       # 全域樣式
├── api/             # Tauri invoke 封裝（每個資源一檔）
├── components/      # 可重用 DOM 元件
├── pages/           # 頁面渲染函式（每個路由一檔）
└── types/index.ts   # 所有 TS interface（與 Rust models.rs 同步）
```

## WHERE TO LOOK

| 任務 | 位置 |
|------|------|
| 新增路由 | `main.ts` → `parseRoute()` + `renderPage()` switch |
| 新增頁面 | `pages/` 新增 `renderXxxPage()` 函式 |
| 新增 API 呼叫 | `api/` 對應資源檔，或新增檔案 |
| 新增元件 | `components/` 新增函式，不得引入外部 UI 套件 |
| 新增型別 | `types/index.ts`，同步更新 Rust `models.rs` |

## CONVENTIONS

- 每個 `pages/*.ts` 匯出單一 `renderXxxPage(container, id?)` 非同步函式
- 每個 `api/*.ts` 只封裝對應資源的 Tauri invoke，不含業務邏輯
- `components/*.ts` 操作 DOM，回傳 `HTMLElement` 或直接掛載至傳入容器
- 路由格式：`#page` 或 `#page/uuid`

## ANTI-PATTERNS

- 禁止直接 `invoke()` 於 pages/ 或 components/（必須透過 api/ 層）
- 禁止引入任何 UI 框架或狀態管理庫
- 禁止在 types/index.ts 以外定義跨模組型別
