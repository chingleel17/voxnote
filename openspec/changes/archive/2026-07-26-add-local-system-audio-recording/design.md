## Context

目前 `src/pages/record.ts` 直接用瀏覽器的 `navigator.mediaDevices.getUserMedia()` 與 `MediaRecorder` 做麥克風錄音，停止後把 `Blob` 交給既有的 `write_recording_file` 流程儲存。這條路徑對純麥克風錄音足夠，但無法穩定擷取桌面應用正在播放的本地音訊，因此在使用耳機參與線上會議時，遠端聲音會缺席。

OpenSpec PRD 已明確列出 Windows WASAPI loopback 與「麥克風 + 系統音訊混音」需求。根據 Windows Core Audio 文件，loopback 必須掛在 render endpoint 的 shared-mode stream；而 Context7 查得的 CPAL 文件適合用於裝置列舉與一般 input stream，但不直接提供 Windows 系統音訊 loopback，因此本次設計需要桌面端的專用錄音管線，而不是只調整前端瀏覽器 API。

## Goals / Non-Goals

**Goals:**
- 在 Windows 提供「僅電腦音訊」與「麥克風 + 電腦音訊混音」錄音模式。
- 保留目前「停止後先預覽、確認後再儲存」的操作體驗。
- 讓新的錄音結果仍可直接沿用既有錄音清單、轉錄、校稿與摘要流程。
- 抽出可重用的桌面音訊輸入管線，讓未來影片檔匯入與離線轉譯可共用音訊標準化邏輯。

**Non-Goals:**
- 本次不處理 macOS Core Audio 實作。
- 本次不提供分軌儲存、即時字幕、字幕翻譯或影片檔匯入 UI。
- 本次不改動既有音訊上傳與會議資料模型的核心流程，除非新增欄位對 UX 明顯必要。

## Decisions

### 1. 將桌面錄音改為後端 session manager，而不是延伸瀏覽器錄音

新增 Rust 錄音模組與 session manager，負責裝置列舉、開始錄音、停止錄音、取消錄音、讀取暫存預覽檔。前端錄音頁只負責模式選擇、狀態顯示與呼叫 Tauri command。

- **Why**：Tauri 2 的 command 模式適合把長時間執行的桌面錄音狀態放在 Rust 端管理，避免前端只能依賴瀏覽器的 media API。
- **Alternative considered**：繼續使用 `MediaRecorder`，再嘗試 `getDisplayMedia` 或驅動程式提供的 Stereo Mix。
- **Why not**：前者在桌面 App 內行為不穩定且 UX 不一致；後者依賴使用者硬體與驅動，無法作為產品預設能力。

### 2. Windows 端採用 WASAPI loopback 擷取系統音訊，麥克風走一般輸入串流，最後混成單一 WAV

系統音訊使用 Windows-specific loopback 實作，麥克風裝置列舉與一般輸入串流可沿用 CPAL 能力；兩路音訊都轉成統一的 PCM 格式後寫入同一個暫存 WAV 檔。

- **Why**：WASAPI loopback 是 Windows 官方支援的系統音訊擷取方式，且不依賴使用者自行啟用特殊虛擬裝置。CPAL 可協助裝置列舉與 mic capture，但 loopback 仍需平台特化。
- **Alternative considered**：完全依賴單一 cross-platform 音訊套件同時處理 loopback 與混音。
- **Why not**：目前可取得的文件不足以證明單一套件可穩定覆蓋 Windows loopback；分開處理能降低實作風險並保留後續擴充空間。

### 3. 停止錄音後先產出暫存檔預覽，再由既有儲存流程提交

`stop` 指令回傳暫存錄音的中介資料，前端將暫存檔讀成預覽播放器，使用者確認後才複製到正式錄音資料夾並建立 recording 記錄。

- **Why**：現有 UX 已經依賴「錄完先聽、再儲存」，直接停錄即寫入正式資料會破壞既有操作習慣。
- **Alternative considered**：停止錄音即自動建立 recording 記錄。
- **Why not**：會讓誤錄、裝置設定錯誤與噪音問題變得更難回復，也會增加清理成本。

### 4. 將錄音模式與裝置偏好寫進設定，而不是只留在頁面狀態

在 `AppConfig` 增加最後使用的錄音模式、預設麥克風裝置與預設系統輸出裝置資訊，讓使用者不必每次重新選擇。

- **Why**：線上會議使用情境高度重複，保留上次成功組合能減少操作成本。
- **Alternative considered**：所有選項都只存在當次頁面 state。
- **Why not**：每次切換會議都要重新設定，與桌面工具的預期操作方式不符。

## Risks / Trade-offs

- **[麥克風與系統音訊時脈不同步]** → 使用緩衝區與統一輸出取樣格式，必要時做重採樣；若 drift 超出可修正範圍，停止錄音並保留部分檔案。
- **[錄音期間裝置切換或拔除]** → session manager 要明確偵測裝置失效，回傳可顯示給使用者的錯誤，並保留已錄到的暫存音檔。
- **[Windows 先行導入造成跨平台行為不一致]** → UI 要在不支援的平台顯示能力說明，避免使用者誤以為功能壞掉。
- **[混音與暫存 WAV 檔增加磁碟使用量]** → 暫存檔固定落在 app data temp 區，取消錄音或儲存完成後立即清理。

## Migration Plan

1. 新增錄音後端模組與 Windows 專用相依套件，先完成裝置列舉與 session lifecycle。
2. 串接錄音頁 UI、設定欄位與新的 Tauri command，保留既有上傳音訊流程不變。
3. 讓停止錄音後的預覽與正式儲存都走新暫存檔流程，再接回既有 recording / transcript 流程。
4. 若上線後需要回退，可先在前端隱藏新模式並保留既有麥克風錄音模式，不影響既有資料。

## Open Questions

- 是否需要在 `recordings` 資料表額外保存錄音來源模式與裝置資訊，供未來搜尋、除錯與匯出使用？
- 未來影片檔匯入若要重用這條音訊管線，是否要在本次就把「暫存音檔標準化」抽成獨立服務介面？
