## Context

動機與能力邊界見 [proposal.md](./proposal.md)；行為契約見 [specs/live-caption-overlay/spec.md](./specs/live-caption-overlay/spec.md)。此處只記錄形塑實作方式的現況與限制。

**既有資產**
- `audio_recording/mod.rs:659` 的 `start_windows_loopback_capture` 已具備完整的 loopback 讀取迴圈：事件驅動等待、`read_from_device_to_deque` 讀取、雙聲道降混、跨批累積重採樣、peak 計算與佇列推送。本變更的目標是**只替換取得 `AudioClient` 的方式**，重用其後全部邏輯。
- `wasapi` 0.23 已封裝 process loopback（`AudioClient::new_application_loopback_client(process_id, include_tree)`）。

**關鍵限制（已於 wasapi 0.23 原始碼 `api.rs:632-681` 確認）**

process loopback 模式下 `AudioClient` 的下列方法不可用，回傳 `Not implemented`：

- `get_mixformat()`——現行程式碼 `audio_recording/mod.rs:701` 以此取得 `actual_rate` 決定是否需要軟體重採樣。
- `get_device_period()`——現行程式碼 `:694` 以此取得 `min_time` 作為 `buffer_duration_hns`。crate 文件明確指出此模式下該值「irrelevant」。
- `get_buffer_size()` 回傳無意義的巨大值、`get_current_padding()` 與 `get_sharemode()` 亦不可用。

`initialize_client` 於此模式下 MUST 使用 `Direction::Capture` 與共用模式。

## Goals / Non-Goals

**Goals**
- 以行程為範圍擷取音訊，重用既有 loopback 讀取迴圈，不重複實作。
- 使用者以應用程式名稱選取目標，不需接觸行程 ID。
- 既有的裝置 loopback 路徑行為完全不變。

**Non-Goals**
- 不做分頁層級的音訊隔離（技術上不成立，見 proposal 的能力邊界）。
- 不支援同時擷取多個應用程式。
- 不將此來源套用至批次錄音流程；本變更僅涉及即時字幕。

## Decisions

### 1. 抽出讀取迴圈，以 `AudioClient` 的取得方式作為唯一分歧點

**選擇**：將 `start_windows_loopback_capture` 中「取得並初始化 `AudioClient` 之後」的部分抽為共用函式，裝置 loopback 與 process loopback 各自負責建立 client，之後匯流至同一段讀取迴圈。

**理由**：兩條路徑的差異僅在 client 來源與格式決定方式；讀取、降混、重採樣、佇列推送完全相同。複製一份迴圈會讓 `add-live-caption-overlay` 已修正的跨批餘數保留邏輯（`:721-726` 的註解記錄了該修正）需要維護兩份。

**注意**：抽出時 MUST 保持既有裝置路徑的行為完全不變。專案無測試（見 `AGENTS.md`），須以實際錄音與字幕手動驗證無回歸。

### 2. process loopback 的取樣率以 `desired_format` 為準，不查詢裝置

**選擇**：process loopback 路徑直接以 `desired_format`（16 kHz、雙聲道、f32）搭配 `autoconvert: true` 初始化，並以該格式為準解析 frame，不呼叫 `get_mixformat()`。

**理由**：該方法在此模式下回傳 `Not implemented`，無從查詢。而 `initialize_client` 若不接受所請求的格式會回傳 `Err`（已於 crate 原始碼確認：其直接將 `wavefmt` 傳給 `IAudioClient::Initialize`，並以 `wavefmt.get_blockalign()` 設定 `bytes_per_frame`），因此初始化成功即代表該格式生效，無須也無法再行查詢。

**與既有裝置路徑的關係**：裝置路徑目前查詢 `get_mixformat()` 並在取樣率不符時補做軟體重採樣（`:737-747`）。該分支對裝置路徑仍有意義（WASAPI 共享模式的格式請求不保證被接受），故**保留不動**；process loopback 路徑則不進入該分支。

### 3. 可選應用程式清單以「目前正在輸出音訊者」為範圍

**選擇**：列舉目前有音訊工作階段的應用程式，取其行程 ID 與可辨識名稱。不列出系統上所有行程。

**理由**：使用者要選的是「正在放影片的那個程式」。列出全部行程會產生數百筆難以辨識的項目，違反 spec 的「以使用者可辨識的名稱呈現」。以音訊工作階段為範圍，清單通常在個位數。

**代價**：目標應用程式必須已在播放聲音才會出現在清單中。使用者需先讓影片開始播放再選取。此取捨須反映於介面提示。

### 4. `include_tree` 固定為 true

**選擇**：建立 process loopback client 時一律傳入 `include_tree = true`。

**理由**：主要使用情境是瀏覽器，而 Chromium 系瀏覽器的音訊由子行程輸出，`false` 會擷取不到聲音。此參數對單一行程的應用程式無副作用（無子行程即無差異），故不需暴露為使用者設定——多一個使用者無從判斷的開關違反「操作越簡單越好」。

### 5. 目標應用程式結束的偵測沿用既有錯誤通道

**選擇**：讀取迴圈遭遇行程已結束所致的錯誤時，寫入既有的 `SharedError`，由 `process_caption_windows` 既有的 `take_error` 路徑結束 session 並回報。

**理由**：`add-live-caption-overlay` 已建立「擷取執行緒錯誤 → SharedError → 字幕迴圈偵測 → 結束並回報」的機制（`live_caption/mod.rs:487-489`）。目標行程結束是此機制涵蓋的一類擷取失敗，不需新增通道。

## Risks / Trade-offs

- **抽出共用迴圈可能回歸既有錄音** → 既有裝置 loopback 同時服務桌面錄音與即時字幕，改壞影響範圍大於本功能本身。緩解：抽出時不改動迴圈內任何邏輯，僅移動；並以三種錄音模式手動驗證（同 `add-live-caption-overlay` 任務 2.6 的做法）。

- **應用程式清單需目標正在發聲才會出現** → 使用者可能在影片尚未播放時開啟清單而找不到目標。緩解：介面明確提示「請先讓目標應用程式開始播放聲音」。

- **process loopback 於部分 Windows 版本行為不一致** → 此 API 自 Windows 10 2004 提供，早期版本可能有缺陷。緩解：啟動前檢查版本並回報；失敗時錯誤訊息需指出可改用「電腦音訊（全系統）」來源。

- **使用者預期分頁層級隔離而失望** → 這是能力邊界而非缺陷。緩解：介面文案明確標示擷取範圍為整個應用程式，spec 亦已將此列為 MUST NOT 誤導的要求。

## Migration Plan

無資料庫 schema 變更、無資料遷移。新增設定欄位由 `AppConfig` 的 `#[serde(default)]` 自動補值。既有使用者的音訊來源設定不受影響，維持其原有選擇。

回滾方式為移除新增的來源選項與 command；既有兩種來源不受影響。

## Open Questions

- 應用程式清單的列舉方式（列舉音訊工作階段 vs. 其他途徑）屬實作細節，不影響 spec 與介面契約，實作時決定即可。
- 目標應用程式結束後是否提供「自動重新選取」而非結束 session，待實際使用後再評估；目前依 spec 結束 session 並回報。
