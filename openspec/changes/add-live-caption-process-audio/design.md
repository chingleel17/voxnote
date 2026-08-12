# 設計：指定應用程式的音訊擷取

## 機制

Windows 10 版本 2004（build 19041）起提供 **process loopback**：`ActivateAudioInterfaceAsync` 搭配 `AUDIOCLIENT_ACTIVATION_PARAMS`，可指定行程 ID 只擷取該行程（可選含子行程）的音訊輸出。

專案既有的 `wasapi` 0.23 已封裝此能力（`AudioClient::new_application_loopback_client(process_id, include_tree)`），無須新增外部相依。

## 能力邊界（最重要的一項）

**擷取粒度是行程，不是瀏覽器分頁。** 瀏覽器的分頁音訊由共用的音訊行程輸出，WASAPI 看不到分頁界線。以 Chromium 系瀏覽器為例，需以 `include_tree = true` 涵蓋子行程，實際結果為「該瀏覽器的全部聲音」。

- 目標是**排除其他應用程式**的干擾 → 此功能成立。
- 目標是**分頁層級隔離** → 此功能做不到，且介面不得讓使用者誤以為可以。

此邊界已寫入規格（「Multiple tabs play audio in the same browser」情境）與前端提示文案（任務 5.3）。

## 技術限制：process loopback 下不可用的方法

已於 `wasapi` 0.23 原始碼確認。直接沿用現行裝置 loopback 的程式碼會失敗：

| 方法 | 此模式下的行為 | 現行用途 | 對策 |
|---|---|---|---|
| `get_mixformat()` | 回傳 `Not implemented` | `audio_recording/mod.rs:701` 取得實際取樣率 | 不呼叫；取樣率以 `desired_format` 為準（初始化成功即代表格式生效） |
| `get_device_period()` | 回傳 `Not implemented` | `:694` 取得 `min_time` 作為 buffer duration | 改傳自訂值（crate 文件指出此模式下該值不影響行為） |
| `initialize_client` | — | — | MUST 使用 `Direction::Capture` 與共用模式 |

取樣率這點需特別留意：commit `06233f6` 修正過「loopback 音訊被重複降取樣約 3 倍速導致轉錄全錯」，其結論正是**以 autoconvert 生效的 `desired_format` 取樣率為準**。本變更的路徑同樣依賴此前提，實作時不得再引入第二處取樣率來源。

## 重構順序

先將既有讀取迴圈抽為共用函式（任務 1.1）並確認裝置 loopback 無回歸（1.3、1.4），再接上 process loopback 路徑（第 2 節）。

理由：兩條路徑的差異僅在**如何取得並初始化 `AudioClient`**，之後的讀取、重採樣、佇列寫入完全相同。若不先抽共用，等於複製一份含跨批餘數保留邏輯（`:721-726`）的重採樣程式碼——該處正是先前出過錯的地方，重複一份等於重複一次風險。

## 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| `include_tree = true` 對某些瀏覽器仍收不到音訊 | 功能對該瀏覽器不可用 | 任務 6.1 以實際瀏覽器驗證；失敗則記錄已知限制 |
| 目標行程結束未被偵測 | 字幕靜默停止而無說明 | 任務 2.6 寫入既有 `SharedError`，由字幕迴圈結束 session 並回報 |
| 使用者預期分頁層級隔離 | 預期落差 | 規格與前端文案雙重說明 |
| 抽共用函式時改動既有錄音行為 | 桌面錄音回歸 | 任務 1.2 要求逐行確認未變，1.3 手動實測三種錄音模式 |

## 與其他變更的關係

- 與 `add-live-caption-remote-asr` **無相依**，但兩者皆修改 `live_caption/mod.rs`、`config/mod.rs`、`liveCaptionSettings.ts`。雖為不同區塊，建議不同時進行以避免合併成本。
- 排程前提（等待轉錄正確性穩定）已於 commit `06233f6` 解除。
