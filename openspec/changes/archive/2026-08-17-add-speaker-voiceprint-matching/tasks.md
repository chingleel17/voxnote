# Tasks

## 1. 服務端輸出嵌入向量

- [x] 1.0 確認容器實際安裝的 whisperx 版本支援 `return_embeddings`（`uv.lock` 現為 3.8.6，但 `pyproject.toml` 僅宣告 `>=3.1`）；必要時提高版本下限
- [x] 1.1 `_ensure_diarize_pipeline` 的呼叫改用 `return_embeddings=True`，接收 `(diarize_df, embeddings)` tuple（`app.py:383-391`）
- [x] 1.2 將 pyannote 原始講者 ID 的向量對應到 `_to_segments` 正規化後的講者代號（A/B/C），確保鍵與分段標籤一致
- [x] 1.3 回應附上向量與 diarization 模型識別（取自 `self._diarization_model`）
- [x] 1.4 非同步任務結果納入相同欄位
- [x] 1.5 向量取得失敗時不中斷轉錄，欄位從缺並記錄 log

## 2. 服務端測試

- [x] 2.1 `server/test_app.py` 測試：啟用語者分離時回應含向量與模型識別
- [x] 2.2 測試：向量的鍵與分段講者代號一致
- [x] 2.3 測試：未啟用語者分離時不含向量欄位
- [x] 2.4 測試：向量取得失敗時轉錄仍完成

## 3. 資料庫

- [x] 3.1 `MIGRATION_SQL` 新增聲紋表 `voiceprints`：以 `saved_participants.id` 為外鍵，含模型識別、向量、建立時間，允許同一參與者多筆（`CREATE TABLE IF NOT EXISTS`）
- [x] 3.1.1 `MIGRATION_SQL` 新增暫存表 `recording_speaker_embeddings`：`(recording_id, speaker_label)` 唯一，含向量、模型識別、建立時間，供使用者確認前的段落內合併與會議內串接比對使用（`CREATE TABLE IF NOT EXISTS`）
- [x] 3.2 決定向量序列化格式並於程式碼註解記錄；讀寫格式一致（兩張表格式一致）
- [x] 3.3 `db/voiceprint.rs`：`voiceprints` 新增、查詢（依模型識別過濾）、依參與者刪除；`recording_speaker_embeddings` 新增（轉錄完成時 upsert）、依會議/錄音查詢
- [x] 3.4 `backup.rs` 納入 `voiceprints` 與 `recording_speaker_embeddings` 兩張表，確認向量格式於備份合併流程正確保留
- [x] 3.5 程式碼註解記錄同名不同人的既有限制（`saved_participants` 以 name 唯一）

## 4. Rust 客戶端解析與比對

- [x] 4.1 `LocalServerTranscription` 新增選填向量與模型識別欄位，沿用 `#[serde(default)]` 慣例
- [x] 4.1.1 轉錄完成且附有向量時，將講者代號與向量 upsert 至 `recording_speaker_embeddings`（不需使用者確認）
- [x] 4.2 cosine 相似度計算（向量已 L2 正規化，距離範圍 0–2）
- [x] 4.3 段落內合併：讀取 `recording_speaker_embeddings` 中單一錄音段落內各講者代號互相比對，產生合併提議（修正 pyannote 把同一人拆為多人）
- [x] 4.4 會議內串接：讀取 `recording_speaker_embeddings` 中同一會議各錄音段落的講者向量互相比對，產生串接提議
- [x] 4.5 跨會議辨識：以 `recording_speaker_embeddings` 中本次向量比對 `voiceprints` 聲紋庫（僅模型相符者），產生候選人名與相似度
- [x] 4.6 確保三層依序執行：段落內合併 → 跨段落串接 → 跨會議辨識
- [x] 4.7 低於門檻時不產生任何提議，不退而提供最接近候選
- [x] 4.8 使用者確認講者對應時，從 `recording_speaker_embeddings` 讀出對應向量寫入 `voiceprints` 並繫結 `saved_participants`
- [x] 4.9 `voiceprint_cmds.rs` 提供前端所需 commands 並註冊至 `lib.rs`

## 5. 設定

- [x] 5.1 `AppConfig` 新增相似度門檻，具保守預設值
- [x] 5.2 設定頁提供門檻調整，說明文字標明僅本地 ASR 適用
- [x] 5.3 `src/types/index.ts` 的 `AppConfig` interface 同步

## 6. 前端呈現

- [x] 6.1 `src/api/voiceprints.ts` invoke 封裝
- [x] 6.2 講者對應區顯示段落內合併提議與跨段落串接提議（哪些代號屬同一人）
- [x] 6.3 顯示跨會議候選人名與相似度，提供逐筆採納與拒絕
- [x] 6.4 未採納前講者對應維持原狀；拒絕時不寫入聲紋
- [x] 6.5 AssemblyAI 供應商時不顯示任何聲紋相關 UI
- [x] 6.6 `styles.css` 補上提議元件樣式

## 7. 端到端驗證

- [x] 7.0 以「同一人被拆成多個講者」的問題錄音驗證段落內合併提議
- [x] 7.1 單場會議多錄音段落、同一人發言：確認串接提議正確
- [x] 7.2 確認講者對應後，第二場會議同一人：確認跨會議候選出現
- [x] 7.3 拒絕提議：確認講者對應未變更且未寫入聲紋
- [x] 7.4 變更 `DIARIZATION_MODEL` 後：確認舊聲紋不參與比對且無錯誤提議
- [x] 7.5 以實際會議錄音實測門檻值，記錄建議設定
- [x] 7.6 備份還原後聲紋比對仍正常運作
- [x] 7.7 AssemblyAI 供應商轉錄：確認流程不受影響
