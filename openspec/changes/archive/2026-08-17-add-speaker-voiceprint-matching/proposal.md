## Why

語者分離以錄音段落為單位執行，`_to_segments` 每次都從 A 重新編號（`app.py:397-421`）。因此錄音段落 1 的「講者A」與段落 2 的「講者A」沒有任何關聯，即使是同一個人。這與 `recording_speaker_mappings` 以 `recording_id` 為唯一鍵的設計一致，但代價是使用者每個錄音段落都要重新指認一次講者；跨會議更是完全從零開始，同一位固定成員在每場會議都要重新標註。

這些資訊其實已經存在但被丟棄。pyannote 內部以 `wespeaker-voxceleb-resnet34-LM` 產生語者嵌入向量，分群後每位講者輸出一個 256 維 centroid；WhisperX 的 `DiarizationPipeline.__call__` 支援 `return_embeddings=True`，回傳 `(diarize_df, {speaker_id: embedding})`。目前服務端未取用，向量在轉錄完成後即遺失。

同時，資料庫已有 `saved_participants`——跨會議的全域參與者登錄表，以 `name` 為唯一鍵並已納入備份還原（`backup.rs:482-515`）。聲紋掛在此表上即可獲得跨會議的身分錨點，不需另立身分概念。

本變更取出這些既有向量並持久化，使系統能以聲線相似度提議講者身分：同一場會議跨錄音段落串接，以及跨會議辨識既有參與者。

## What Changes

- 服務端啟用 `return_embeddings`，於轉錄回應附上每位講者的嵌入向量與產生該向量的模型識別。
- Rust app 解析向量，並以相似度處理三個層級：單一錄音段落內被過度分割的講者代號合併、同一會議跨錄音段落的講者串接、跨會議的參與者辨識。
- 新增聲紋資料表，將向量繫結至 `saved_participants`，供跨會議比對。
- 使用者確認講者對應時，該講者的向量存入聲紋庫；同一參與者可累積多筆聲紋。
- 轉錄完成後，系統以聲紋庫比對並**提議**講者身分，由使用者逐筆採納或拒絕，MUST NOT 自動套用。
- 每筆聲紋記錄產生模型識別；模型不符的聲紋不參與比對。
- 僅本地 ASR（voxnote_asr）供應商提供本能力；AssemblyAI 維持現狀。

**不包含**：

- 不自動套用比對結果（見 Design Decisions）。
- 不改動語者標籤的產生方式與 `講者A/B/C` 格式。
- 不提供聲紋管理介面（檢視、刪除個別聲紋）——第一版僅隨講者確認累積。
- 不使用 LLM 進行語者校正。
- 不改動 `recording_speaker_mappings` 以 `recording_id` 為範圍的既有設計。

## Capabilities

### New Capabilities

- `speaker-voiceprint-matching`: 以語者嵌入向量合併段落內過度分割的講者、串接跨錄音段落與跨會議的講者身分，經使用者確認後採納。

### Modified Capabilities

- `local-asr-server`: 轉錄回應新增講者嵌入向量與模型識別。

## Design Decisions

### 為何提議而非自動套用

聲線相似度是機率判斷，不是事實。錯誤比對若自動套用，會靜默污染講者對應、摘要的參與人員章節，以及 `ai_cmds.rs` 的 `build_speaker_reference_block` 餵給 LLM 的講者參照——使用者難以察覺錯誤來源。

系統 MUST 以提議形式呈現（顯示候選人名與相似度），由使用者採納。結構化逐字稿編輯器已具備逐列採納語意，人工確認成本低。

### 為何繫結 `saved_participants` 而非 `participants`

`participants` 以 `meeting_id` 為外鍵，屬單場會議範圍，無法承載跨會議身分。`saved_participants` 為全域且以 `name` 唯一，已是跨會議的參與者概念，並已納入備份還原。聲紋 MUST 繫結至 `saved_participants`。

### 模型識別為必要欄位

嵌入向量僅在同一模型下可比較。`DIARIZATION_MODEL` 可由環境變數覆寫（`app.py:272-273`），若模型變更而未記錄來源，既有向量會靜默產生無意義的相似度——這是最危險的失效模式，因為它不會報錯，只會給出錯誤提議。

每筆聲紋 MUST 記錄產生模型識別，比對時 MUST 僅納入模型相符者。此欄位事後補建成本高，故於第一版即納入。

### 一位參與者多筆聲紋

同一人在不同麥克風、環境與情緒下的向量會有差異。限制單筆會使聲紋庫隨覆寫而退化。資料表 MUST 允許一位參與者累積多筆聲紋，比對時取最佳相似度。

### 相似度門檻可設定

適合中文會議與實際錄音環境的門檻需實測。門檻 MUST 可設定且具保守預設值，MUST NOT 硬編碼。低於門檻時不提議，MUST NOT 強行給出最接近的候選。

### 與其他兩個變更的關係

**`add-diarization-confidence-signal`**：兩者修改相同的兩處介面（`server/app.py` 的轉錄回應組裝、`asr/mod.rs` 的 `LocalServerTranscription`）。本變更建議於其完成後實作，以避免同一處介面的並行修改造成衝突。兩者無功能相依，順序僅為實作便利。

**`improve-diarization-accuracy`**：該變更以分群門檻調整**事前預防**同一人被拆為多個講者，本變更的段落內合併為**事後補救**。門檻無法對所有錄音都調到最佳（音量、環境、發言間隔差異隨錄音而變），故兩道防線並存，MUST NOT 以其一取代另一。

### 僅限本地 ASR

AssemblyAI 為黑箱 API，不暴露嵌入向量。本能力 MUST 僅於本地 ASR 供應商啟用；使用 AssemblyAI 時 MUST NOT 顯示相關 UI，避免呈現無法運作的功能。

## Impact

**新增檔案**

- `src-tauri/src/db/voiceprint.rs`：聲紋 CRUD 與相似度比對。
- `src-tauri/src/commands/voiceprint_cmds.rs`：聲紋相關 Tauri commands。
- `src/api/voiceprints.ts`：前端 invoke 封裝。

**修改既有檔案**

- `server/app.py`：`_ensure_diarize_pipeline` 呼叫改用 `return_embeddings=True`，回應附上向量與模型識別。
- `server/test_app.py`：向量輸出與模型識別的測試。
- `src-tauri/src/asr/mod.rs`：解析向量欄位並向上傳遞。
- `src-tauri/src/db/mod.rs`：新增聲紋資料表（`CREATE TABLE IF NOT EXISTS`，符合既有 migration 慣例）。
- `src-tauri/src/db/models.rs` 與 `src/types/index.ts`：新增聲紋型別。
- `src-tauri/src/backup.rs`：聲紋表納入備份還原範圍。
- `src-tauri/src/config/mod.rs`：相似度門檻設定。
- `src/pages/meeting.ts`：講者提議的呈現與採納操作。

**不需修改**

- `_to_segments` 的講者代號正規化：本變更不改動標籤格式。
- `recording_speaker_mappings`：既有的 `recording_id` 範圍設計維持不變。
- AssemblyAI 路徑。

**外部相依**

- WhisperX `DiarizationPipeline.__call__` 的 `return_embeddings=True`（回傳 `(diarize_df, embeddings)`）。`uv.lock` 現解析為 whisperx 3.8.6，具備此參數；但 `pyproject.toml` 宣告為 `whisperx>=3.1` 下限而非鎖定，實作時 MUST 確認容器實際安裝版本仍支援，必要時提高版本下限。
- pyannote community-1 內部的 `wespeaker-voxceleb-resnet34-LM`，256 維向量。

**限制**

- 僅本地 ASR 供應商可用。
- 更換 diarization 模型後，既有聲紋不再參與比對（依模型識別過濾），需重新累積。
