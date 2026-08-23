# 設計：指定應用程式的音訊擷取

## 機制

Windows build 20348 起提供 **process loopback**：`ActivateAudioInterfaceAsync` 搭配 `AUDIOCLIENT_ACTIVATION_PARAMS`，可指定行程 ID 只擷取該行程及其子行程的音訊輸出。最低 build 依 Microsoft API 文件與 Application Loopback 官方範例，不沿用較早草案的 build 19041。

專案既有的 `wasapi` 0.23 已封裝此能力（`AudioClient::new_application_loopback_client(process_id, include_tree)`），無須新增外部相依。

## 能力邊界（最重要的一項）

**擷取粒度是行程，不是瀏覽器分頁。** 瀏覽器的分頁音訊由共用的音訊行程輸出，WASAPI 看不到分頁界線。以 Chromium 系瀏覽器為例，需以 `include_tree = true` 涵蓋子行程，實際結果為「該瀏覽器的全部聲音」。

- 目標是**排除其他應用程式**的干擾 → 此功能成立。
- 目標是**分頁層級隔離** → 此功能做不到，且介面不得讓使用者誤以為可以。

此邊界已寫入規格（「Multiple tabs play audio in the same browser」情境）與前端提示文案（任務 5.3）。

## 使用情境邊界

指定應用程式擷取屬於即時字幕能力，適用於線上會議、直播，以及無法先取得完整媒體的其他即時來源。對可存取的非直播 YouTube 影片，應優先使用 `add-video-url-subtitle` 的預先轉錄與內嵌播放流程，因為完整上下文與播放器媒體時間能提供較可靠的字幕與同步。

本能力不需要偵測或阻止使用者對 YouTube 使用即時字幕，但介面與文件不得將它描述成已存在 YouTube 影片的建議流程，也不得與影片字幕能力共用資料或播放狀態。

## 目標識別與生命週期

音訊工作階段通常屬於應用程式的子行程。若直接把該 PID 傳給 `include_tree = true`，只能涵蓋該子行程及其後代，未必代表整個應用程式。因此列舉流程必須：

1. 從所有作用中輸出端點的音訊 session 取得目前正在輸出音訊的 PID。
2. 將音訊 PID 解析為可代表該應用程式行程樹的根目標，並以穩定的應用程式識別資訊去重。
3. 回傳顯示名稱與本次可用的根 PID；無法安全解析者不得宣稱為整個應用程式擷取。

PID 可能在應用程式重啟後失效或被其他行程重用，因此只存在於前端當次選取狀態及 `start_live_caption` 請求，不寫入 `AppConfig`。後端在建立 capture client 前必須重新驗證 PID 仍存在，且其識別資訊仍符合使用者所選項目；驗證失敗時要求重新整理清單與重選，不可擷取剛好重用該 PID 的其他行程。

應用程式仍存在但暫時沒有 render stream 時，Microsoft 契約會提供靜音，這不是「應用程式已結束」。session 應維持運作並沿用既有靜音處理；只有目標根行程確實結束、擷取失敗或使用者停止時才終止。

## 技術限制：process loopback 下不可用的方法

已於 `wasapi` 0.23 原始碼確認。直接沿用現行裝置 loopback 的程式碼會失敗：

| 方法 | 此模式下的行為 | 現行用途 | 對策 |
|---|---|---|---|
| `get_mixformat()` | 回傳 `Not implemented` | 裝置 loopback 僅用於記錄音訊引擎格式 | 不呼叫；取樣率以 `desired_format` 為準（初始化成功即代表格式生效） |
| `get_device_period()` | 回傳 `Not implemented` | 裝置 loopback 取得 `min_time` 作為 buffer duration | 改傳自訂值（crate 文件指出此模式下該值不影響行為） |
| `initialize_client` | — | — | MUST 使用 `Direction::Capture` 與共用模式 |

取樣率這點需特別留意：commit `06233f6` 修正過「loopback 音訊被重複降取樣約 3 倍速導致轉錄全錯」，其結論正是**以 autoconvert 生效的 `desired_format` 取樣率為準**。本變更的路徑同樣依賴此前提，實作時不得再引入第二處取樣率來源。

## 重構順序

先將既有讀取迴圈抽為共用函式（任務 1.1）並確認裝置 loopback 無回歸（1.3、1.4），再接上 process loopback 路徑（第 2 節）。

理由：兩條路徑的差異僅在**如何取得並初始化 `AudioClient`**，之後的 f32 雙聲道讀取、單聲道混合、約 100 毫秒批次推送與音量更新完全相同。兩者初始化時都要求 `autoconvert` 直接交付 16 kHz，不得在共用迴圈加入第二次重採樣或第二個「實際取樣率」來源；這正是 commit `06233f6` 已修正的錯誤。

process loopback 匯入與麥克風／全系統擷取相同的 `SharedQueue` 後，不再建立來源專屬的轉錄分支。如此 `add-streaming-incremental-caption` 的間隔驅動與 LocalAgreement，以及增量模式關閉時的視窗式處理，都能原樣套用。

## 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| `include_tree = true` 對某些瀏覽器仍收不到音訊 | 功能對該瀏覽器不可用 | 任務 6.1 以實際瀏覽器驗證；失敗則記錄已知限制 |
| 音訊 session PID 是子行程或 PID 已被重用 | 擷取不完整或誤擷取其他程式 | 解析根目標、去重，啟動前複核應用程式身分；PID 不落盤 |
| 目標行程結束未被偵測 | 字幕靜默停止而無說明 | 任務 2.7 寫入既有 `SharedError`，由字幕迴圈結束 session 並回報 |
| 使用者預期分頁層級隔離 | 預期落差 | 規格與前端文案雙重說明 |
| 抽共用函式時改動既有錄音行為 | 桌面錄音回歸 | 任務 1.2 要求逐行確認未變，1.3 手動實測三種錄音模式 |

## 與其他變更的關係

- 與 `add-live-caption-remote-asr` **無相依**，但兩者皆修改 `live_caption/mod.rs`、`config/mod.rs`、`liveCaptionSettings.ts`。雖為不同區塊，建議不同時進行以避免合併成本。
- 與 `add-streaming-incremental-caption` **無解碼契約相依**；本變更只供應音訊。若兩者同時開發，應先整合本變更的 session 請求與擷取分支，再讓新版 `process_caption_windows()` 共用該來源，避免各自建立處理迴圈。
- 與 `add-video-url-subtitle` 的範圍互補：既有非直播 YouTube 影片走預先轉錄與內嵌播放器；本變更保留給直播、會議與其他即時來源。
- 排程前提（等待轉錄正確性穩定）已於 commit `06233f6` 解除。
