## Why

即時字幕目前的「電腦音訊」來源是**整台裝置的輸出**（`start_windows_loopback_capture` 以 `Direction::Render` 取預設輸出裝置後開 loopback）。實際使用情境是觀看瀏覽器中的影片，但此擷取方式會一併收錄同時段的所有系統聲音——通知音效、其他分頁的自動播放、音樂播放器、會議軟體提示音。這些非目標音訊會與影片語音混在同一個視窗送入模型，降低轉錄品質。

Windows 10 版本 2004 起提供 **process loopback**（`ActivateAudioInterfaceAsync` 搭配 `AUDIOCLIENT_ACTIVATION_PARAMS`），可指定行程 ID 只擷取該行程（可選含其子行程）的音訊輸出。專案既有的 `wasapi` 0.23 相依**已封裝此能力**（`AudioClient::new_application_loopback_client(process_id, include_tree)`，已於 crate 原始碼確認），無須新增外部相依。

**能力邊界（重要，避免預期落差）**：此機制的粒度是**行程**，不是瀏覽器分頁。瀏覽器的分頁音訊由共用的音訊行程輸出，WASAPI 看不到分頁界線。以 Chromium 系瀏覽器為例，需以 `include_tree = true` 涵蓋其子行程，實際結果為「該瀏覽器的全部聲音」而非單一分頁。若使用者的目標是排除其他應用程式的干擾，此功能成立；若目標是分頁層級的隔離，此功能無法達成。

## What Changes

- **新增「指定應用程式」音訊來源**：即時字幕的音訊來源除既有的「麥克風」「電腦音訊（全系統）」外，新增可指定單一應用程式的來源。
- **可選取的應用程式清單**：提供目前正在輸出音訊的應用程式清單供使用者選擇，使用者無須自行查找行程 ID。
- **子行程涵蓋**：擷取指定應用程式時一併涵蓋其子行程，以支援採多行程架構的瀏覽器。
- **目標應用程式結束的處理**：被擷取的應用程式於 session 進行中結束時，回報原因並結束 session，而非靜默停止產生字幕。

本變更不修改既有的麥克風與全系統音訊擷取行為，不影響批次錄音流程，無 breaking change。

## Capabilities

### New Capabilities
<!-- 無新增 capability。 -->

### Modified Capabilities
- `live-caption-overlay`: 新增以應用程式為單位的音訊來源選項。

## Dependency

`add-live-caption-overlay` 已於 2026-08-11 完成並歸檔，`live-caption-overlay` 已進入 `openspec/specs/` 基準（該基準定義了即時字幕的音訊來源機制與 session 生命週期）。本變更的 spec delta 以 `## ADDED Requirements` 撰寫，新增基準未涵蓋的音訊來源。

本變更與 `add-live-caption-remote-asr` 無相依，兩者可獨立進行。

**排程建議**：先前的排程前提（等待轉錄正確性穩定）已解除——取樣率錯配與幻覺過濾已於 commit `06233f6` 修正並歸檔。本變更現可開始，惟實測時仍應以「電腦音訊（全系統）」作為對照組，確認品質差異來自音訊來源而非轉錄路徑。

## Impact

**修改既有檔案**
- `src-tauri/src/audio_recording/mod.rs`：新增以行程為目標的 loopback 擷取路徑。既有的裝置 loopback 函式不變。
- `src-tauri/src/live_caption/mod.rs`：音訊來源驗證與啟動分支新增此來源。
- `src-tauri/src/commands/live_caption_cmds.rs`：新增列舉可選應用程式的 command。
- `src-tauri/src/config/mod.rs` 與 `src/types/index.ts`：新增目標應用程式的設定欄位。
- `src/components/liveCaptionSettings.ts`：音訊來源選單新增此選項與應用程式挑選介面。

**外部相依**
- 無新增。`wasapi` 0.23 已提供 `new_application_loopback_client`。

**技術限制（已於 wasapi 0.23 原始碼確認）**

process loopback 模式下 `AudioClient` 的多個方法不可用，直接沿用現行裝置 loopback 的程式碼會失敗：

- `get_mixformat()` 回傳 `Not implemented`——現行程式碼於 `audio_recording/mod.rs:701` 以此取得實際取樣率，此路徑必須改以其他方式決定格式。
- `get_device_period()` 回傳 `Not implemented`——現行程式碼於 `:694` 以此取得 `min_time` 作為 buffer duration，此路徑須改為傳入自訂值（crate 文件指出該值於此模式下不影響行為）。
- `initialize_client` 必須使用 `Direction::Capture` 與共用模式。

**平台限制**
- 僅 Windows 10 版本 2004（build 19041）以上支援。低於此版本或非 Windows 平台，此音訊來源不可用，須於啟動前回報。
