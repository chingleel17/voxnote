## Purpose

確保 Tauri 開發模式中的 Vite dev server 僅監看前端熱更新所需檔案，不因後端虛擬環境、模型快取、Rust 建置產物或規格工具目錄含有大量檔案而失去回應，避免 Rust 重建後主視窗長時間停留於空白畫面。

## Requirements

### Requirement: Vite watcher excludes non-frontend development trees

Vite dev server MUST 排除不參與前端 HMR 的大型或非前端目錄。排除範圍 MUST 至少涵蓋 Rust 專案與建置產物、Python 服務及其虛擬環境與模型快取、OpenSpec artifacts，以及代理工具設定目錄。

新增可能含大量產物、套件、模型或快取的專案根目錄時，開發設定 MUST 同步評估並排除該目錄，MUST NOT 依賴 `.gitignore` 取代 Vite watcher 設定。

#### Scenario: Python virtual environment exists under the project root

- **WHEN** `server/.venv` 存在且包含數萬個相依套件檔案，開發者啟動 Vite 或 `tauri dev`
- **THEN** Vite watcher MUST NOT 遞迴監看該虛擬環境，dev server MUST 維持可回應

#### Scenario: Rust or ASR artifacts change during development

- **WHEN** Rust `target`、ASR 模型、Hugging Face 快取、OpenSpec 文件或代理工具設定發生變更
- **THEN** Vite MUST NOT 因這些變更觸發前端 HMR 或大量重新掃描，Tauri 與後端各自的 watcher MUST 仍可獨立處理其負責範圍

### Requirement: Development rebuild keeps the frontend server responsive

執行 `tauri dev` 並發生 Rust 重建時，Vite dev server MUST 持續提供入口 HTML、`/@vite/client` 與目前路由所需的前端模組。Rust 重建完成後，主視窗 MUST NOT 因等待失去回應的 Vite dev server 而長時間停留於只有背景與版面框架的空白畫面。

在一般開發機的暖機狀態下，對 `http://localhost:1420/@vite/client` 的本機請求 SHOULD 於 1 秒內完成；若超過 5 秒，MUST 視為開發環境效能退化並檢查 watcher handle 數與被監看的目錄。

#### Scenario: Rust source triggers a development rebuild

- **WHEN** `tauri dev` 因 Rust 原始碼變更重新編譯並重新啟動應用程式
- **THEN** Vite dev server MUST 在重建期間保持可回應，應用程式重新連線後 MUST 能載入目前路由，而非等待數十秒或數分鐘

#### Scenario: Watcher regression is diagnosed

- **WHEN** dev server 回應超過 5 秒或主視窗於重建後長時間空白
- **THEN** 開發者 MUST 量測 `localhost:1420` 回應時間、Vite 程序 handle 數及實際監看範圍，並優先排查新增的大型非前端目錄

### Requirement: Initial route loading avoids unnecessary page modules and duplicate queries

前端啟動 MUST 僅載入目前路由所需頁面模組，MUST NOT 為顯示首頁而預先載入所有大型頁面。首次建立預設 `#home` 路由時，系統 MUST 僅執行一次首頁渲染與資料查詢。

頁面模組或啟動設定載入失敗時，系統 MUST 顯示可理解的錯誤並寫入 Console，MUST NOT 無限停留於無錯誤資訊的空白畫面。

#### Scenario: Application starts without an existing hash route

- **WHEN** 開發模式主視窗首次載入且 URL 尚無 hash route
- **THEN** 系統 MUST 將目前路由設為 `#home` 並只執行一次首頁資料載入

#### Scenario: A lazily loaded page fails to load

- **WHEN** 目前路由的動態頁面模組載入失敗
- **THEN** 內容區 MUST 顯示頁面載入失敗訊息，Console MUST 保留原始錯誤供診斷

## Verification Baseline

2026-08-13 問題重現時，Vite 因監看 `server/.venv`（約 34,759 個檔案）持有約 29,507 個 handles，記憶體約 564 MB，`/@vite/client` 回應約 56 秒，Tauri 主視窗因此長時間空白。

排除非前端目錄後，同機量測為約 332 個 handles、95 MB，入口 HTML 約 21 ms、`/@vite/client` 約 8 ms、`src/main.ts` 約 2 ms。此數值為退化診斷基準，不是跨硬體的固定產品 SLA。
