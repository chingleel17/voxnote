## Context

本變更的動機與範圍請參考 `proposal.md`，需求情境請參考
`specs/local-asr-server/spec.md`。目前本地 ASR 服務會先執行 WhisperX 詞級強制對齊，
再於啟用語者分離時將語者區間指派至詞級結果。對齊失敗時，服務保留未對齊的分段結果
繼續轉錄，因此逐字稿仍可使用，但語者標籤的可靠度下降。

此變更跨越 Python ASR 服務、Rust ASR 客戶端、SQLite `recordings` 資料表與 Vanilla
TypeScript 會議頁。既有資料庫以 `MIGRATION_SQL` 建立初始 schema，並以啟動時的
`ALTER TABLE` 補上後續欄位；Rust 的 SQLite 布林值以 `INTEGER` 儲存，前端目前以數字
欄位接收資料。

## Goals / Non-Goals

**Goals:**

- 讓本地 ASR 回應明確帶出語者分離是否因詞級對齊失敗而降級。
- 讓同步回應與非同步任務完成結果使用同一份回應組裝邏輯，避免欄位不一致。
- 以選填回應欄位與預設值維持新舊服務端及客戶端的互通性。
- 將降級狀態保存到錄音段落，並在會議頁的段落及講者對應區提供品質提示。
- 讓既有資料庫在升級後以未降級預設值運作，不需回填歷史資料。

**Non-Goals:**

- 不改變詞級對齊失敗時繼續轉錄的處理策略。
- 不重新設計語者分離、講者標籤正規化或逐字稿格式。
- 不提供重新對齊、重跑語者分離或自動修正講者標籤的流程。
- 不將 AssemblyAI 或一般本地 Whisper 路徑改造成可回報此狀態的來源。

## Decisions

### 1. 使用 `diarization_degraded` 布林訊號

服務端以 `diarization_degraded` 表示本次語者分離是否在詞級對齊未完成的情況下
產生。其值由 `diarize and not alignment_complete` 計算，而不是由呼叫端自行推測。
未啟用語者分離時固定為 `false`，因此客戶端可用單一欄位與既有的
`diarization_enabled` 語意判斷是否顯示提示。

選擇布林值而非錯誤物件或品質分數，因為目前唯一已知的降級原因是詞級對齊失敗，且
該失敗不應使整體轉錄進入失敗狀態。分數會暗示尚未定義的校準方式；錯誤物件則會把
仍可使用的逐字稿誤呈現為不可用。

### 2. 在共用轉錄流程組裝同步與非同步回應

`WhisperXTranscriber.transcribe()` 保留現有 `aligned` 判定，將對齊完成狀態與分段及
嵌入向量一併回傳。`_transcribe_audio()` 接收該狀態並建立包含
`diarization_enabled`、`diarization_degraded` 的標準回應；非同步任務只保存這份回應
到任務結果，不另行重組欄位。

選擇共用組裝函式而非在同步 endpoint 與任務完成處各自補欄位，是為了讓兩種 API 模式
持續遵守相同契約，也讓未來新增回應欄位時只有一個修改點。對齊例外仍由既有的
`try/except` 吸收，只有訊號值改為 `true`，不改變轉錄流程或分段輸出。

### 3. 以選填欄位支援舊版服務端

Rust 的 `LocalServerTranscription.diarization_degraded` 使用
`#[serde(default)]`，缺少欄位時反序列化為 `false`。本地 ASR 的公開結果
`VoxnoteAsrResult` 再將此值傳給 Tauri command；AssemblyAI 與一般本地 Whisper 分支
維持 `false`。

這個相容策略優先保留舊版服務端的既有可用行為。代價是新版 app 無法辨識舊版服務端
實際上是否曾發生對齊降級，但這是缺少訊號時唯一不會誤報的預設值；新版服務端回傳
額外欄位時，舊版 app 則會依既有 JSON 反序列化行為忽略該欄位。

### 4. 在錄音段落保存狀態，使用 SQLite 整數布林值

`recordings` 新增 `diarization_degraded INTEGER NOT NULL DEFAULT 0`。初始 schema 與
啟動時的向下相容 migration 都加入相同欄位；舊資料列由 SQLite 使用 `0` 初始化。
錄音查詢的欄位清單、Rust `Recording` struct 與前端 `Recording` interface 同步加入
此欄位。

ASR command 僅在本地 ASR 結果提供時更新狀態，並透過
`update_segment_transcript()` 同時寫入逐字稿、清除舊校稿內容及設定降級值。這讓一個
錄音段落的文字與其品質狀態在同一個資料庫更新操作中完成，避免只更新其中一項。
AssemblyAI、一般本地 Whisper 及舊版服務端缺少欄位時都會保存 `0`。

### 5. 在兩個實際校正位置共用品質提示

會議頁以 `diarization_degraded === 1` 判斷 SQLite 布林值，透過共用的提示建立函式
在錄音段落及講者對應區插入相同文案。文案明確指出應優先確認講者對應，並保留逐字稿
文字可正常使用的訊息；未降級或未啟用語者分離的段落不插入元素。

提示放在既有講者校正內容旁，而不是轉錄完成通知中，確保使用者稍後重新開啟會議時
仍能在實際校正位置看到它。樣式沿用現有提示元件的視覺語言，不新增互動或重跑操作。

### 6. 備份與還原沿用 `recordings` 的既有範圍

`recordings` 已在備份及還原的表格清單中，新增欄位隨該表既有的欄位複製流程保存，
不另建獨立備份資料結構。備份測試 schema 同步包含欄位，以確保匯出／匯入測試使用與
正式 schema 相同的資料形狀。

## Risks / Trade-offs

- **[舊版服務端缺少欄位]** → Rust 以 `#[serde(default)]` 視為未降級，避免舊版服務端
  造成解析失敗；代價是無法回溯舊版服務端的實際對齊狀態。
- **[詞級對齊失敗但語者標籤仍可能不完整]** → 維持既有未對齊結果，不阻斷逐字稿，並
  以 `diarization_degraded` 及會議頁提示把人工確認責任交給使用者。
- **[SQLite 布林值跨層型別不同]** → 資料庫使用 `INTEGER NOT NULL DEFAULT 0`，Rust
  以 `i64` 接收，前端集中以 `=== 1` 判斷，避免將任意 truthy 值誤當成降級。
- **[同步與非同步回應可能再次漂移]** → 兩者都呼叫 `_transcribe_audio()` 產生結果，並
  以伺服器測試驗證相同降級狀態。
- **[舊資料庫缺少欄位]** → 啟動時執行可重複的 `ALTER TABLE`，並以 `DEFAULT 0` 保持
  既有錄音不顯示提示；回滾時保留欄位，不執行破壞性的移除 migration。
- **[品質提示增加介面噪音]** → 只在確定降級的語者分離段落顯示，正常轉錄及非語者分離
  路徑完全不新增 UI。

## Migration Plan

1. 先部署包含 `diarization_degraded` 回應欄位的本地 ASR 服務，再部署能解析、保存及
   顯示該欄位的 VoxNote app；若部署順序相反，選填欄位預設值仍可維持運作。
2. app 啟動時執行既有資料庫初始化流程，對舊版 `recordings` 表補上欄位；新建立的
   資料庫則由初始 schema 直接建立欄位。
3. 轉錄完成後，新欄位跟隨錄音段落寫入，會議頁依保存值顯示提示；既有錄音與未降級
   結果保持不顯示提示。
4. 回滾 app 或服務端時保留資料庫欄位。舊 app 會忽略新增的服務端欄位，舊服務端則
   由新 app 將缺少欄位的結果視為未降級；不刪除欄位，也不需要資料轉換或回填。
