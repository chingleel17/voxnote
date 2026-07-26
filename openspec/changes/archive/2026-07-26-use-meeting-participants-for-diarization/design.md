## Context

`add-local-breeze-asr-service` 當初將「預期講者人數」設計為設定頁的全域選填欄位（`local_asr_speaker_hint`）。但 VoxNote 的資料模型中，每場會議本就有與會人員名單（`participants` 資料表，依 `meeting_id` 關聯，`MeetingWithDetails.participants: Vec<String>`），使用者在建立會議時已填寫。全域人數設定無法反映各場會議差異，且屬重複輸入。

同時，AssemblyAI 支援 `speakers_expected` 參數提升語者分離準確度，先前未帶入。

## Goals / Non-Goals

**Goals:**
- 預期講者人數由會議與會人員數自動推導，移除設定頁欄位。
- 兩個支援語者分離的供應商（AssemblyAI、voxnote_asr）皆帶入人數。
- 無與會人員或查詢失敗時安全降級，不中斷轉錄。

**Non-Goals:**
- 不提供手動覆寫人數的欄位（與會人員名單即單一來源）。
- 不改動語者標籤與逐字稿輸出格式。
- 不使用 AssemblyAI 的 `speaker_options` 範圍模式。

## Decisions

### 決策 1：於 `start_transcription` 查詢會議取得人數

`start_transcription` 已具備 `meeting_id` 與 `pool`，直接呼叫 `meeting::get_meeting()` 取 `participants.len()`。人數在轉錄前一次取得並傳入供應商函式，供應商函式本身不查資料庫，維持職責單一、易測試。

*替代方案*：由前端傳入人數——但前端可能與資料庫狀態不同步，且增加 IPC 參數，不採用。

### 決策 2：查詢失敗以 0 表示未知，安全降級

以 `.ok().flatten().map(...).unwrap_or(0)` 取得人數；任何查詢失敗或無與會人員皆得 0。0 代表未知，供應商層不帶入人數參數，交由其自動偵測。**人數取得失敗不應中斷轉錄**——轉錄本身仍可完成，只是分離準確度略降。

### 決策 3：AssemblyAI 用 `speakers_expected`，不用範圍模式

官方文件指出：確知人數時用 `speakers_expected`，不確定時才用 `speaker_options` 的 min/max 範圍。與會人員名單即為確知人數，故用 `speakers_expected`。並限制 1–20（AssemblyAI 支援範圍）才帶入。

### 決策 4：自架服務沿用 min=max 鎖定

`voxnote_asr` 服務端已接受 `min_speakers`/`max_speakers`（pyannote 提示）。人數確知時兩者皆設為該值，等同鎖定，無需變更服務端 API 契約。

### 決策 5：移除設定欄位不需 migration

`AppConfig` 具 `#[serde(default)]`，移除欄位後舊 config.toml 中殘留的 `local_asr_speaker_hint` 鍵會被 serde 忽略，不會反序列化失敗。

## Risks / Trade-offs

- **與會人員數不等於實際發言人數**（有人全程未發言、或有未列名者發言）→ 鎖定人數可能誤導分離。此為既有設計的固有取捨；AssemblyAI 文件亦指出人數提示有助準確度。若實測發現負面影響，可改為僅傳 `max_speakers` 或改用範圍模式。
- **AssemblyAI 對短音檔忽略此參數**（少於 2 分鐘）→ 屬其服務行為，已於程式碼註解記錄，無需特別處理。
- **人數超過 20** → 超出 AssemblyAI 支援範圍時不帶入，避免 API 回錯。

## Migration Plan

1. Rust：查詢會議取人數 → 傳入兩供應商 → 移除 config 欄位。
2. 前端：移除 UI 與型別欄位、更新說明文字。
3. 驗證編譯與端到端轉錄行為。

**Rollback**：回復 config 欄位與設定頁 UI 即可；AssemblyAI 的 `speakers_expected` 為附加參數，移除不影響原有行為。
