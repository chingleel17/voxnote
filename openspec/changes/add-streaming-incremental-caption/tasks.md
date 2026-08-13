## 1. 設定與型別

- [ ] 1.1 於 `AppConfig`（`src-tauri/src/config/mod.rs`）新增 `live_caption_incremental_enabled`（預設值於 6.x 實測後決定，初期先設 `false` 以免影響既有行為）
- [ ] 1.2 於 `AppConfig` 新增 `live_caption_decode_interval_ms`（解碼間隔，預設 800ms），與既有的 `live_caption_window_seconds` 為獨立參數（見 design 決定 2）
- [ ] 1.3 加入參數驗證：解碼間隔 MUST 小於分析視窗長度，違反時於 session 啟動即回報明確錯誤（對應 spec「Decode interval is shorter than the window length」）
- [ ] 1.4 於 `src/types/index.ts` 同步新增對應 TypeScript 型別欄位
- [ ] 1.5 確認既有 config 檔案缺少新欄位時可正確套用預設值（比照 `config/mod.rs` 現有的向下相容測試）

## 2. LocalAgreement 政策（純邏輯，先於整合）

> 政策完全實作於 Rust 端，伺服器不參與 agreement 判定（見 design 風險「兩條路徑的政策實作分歧」）。

- [ ] 2.1 新增 LocalAgreement 狀態結構：保存「上一次解碼結果」與「已確定的文字」
- [ ] 2.2 實作共同前綴比對：輸入本次解碼結果，回傳新確定的文字與剩餘的暫定文字（對應 spec「Consecutive decodes produce the same leading text」）
- [ ] 2.3 確保已確定的文字不因後續解碼結果不同而被修改或撤回（對應 spec「Confirmed text is never revised」）
- [ ] 2.4 實作 session 結束時將剩餘暫定文字輸出為最終內容（對應 spec「Audio ends while text is still tentative」）
- [ ] 2.5 為 2.2–2.4 撰寫單元測試，涵蓋：連續一致、連續不一致、確定後結果改變、結束時仍有暫定文字四種情境
- [ ] 2.6 確認比對邏輯對中英文皆正確（中文無詞界、英文以空白分隔，前綴比對的粒度需一致處理）

## 3. 取樣迴圈改為間隔驅動

- [ ] 3.1 將 `process_caption_windows()` 的觸發條件由「視窗填滿」改為「距上次解碼已達解碼間隔」（增量模式啟用時）
- [ ] 3.2 每次解碼取用最近「分析視窗長度」的音訊；音訊不足一個視窗時仍應解碼已有的部分，不等待填滿（對應 spec「Speech is emitted while its window is still filling」）
- [ ] 3.3 實作解碼耗時超過解碼間隔時略過該次解碼，不累積待處理工作（對應 spec「Decoding is slower than the decode interval」）
- [ ] 3.4 增量模式關閉時，維持現行的視窗式行為完全不變（對應 spec「User disables incremental mode」）
- [ ] 3.5 確認 `is_duplicate()` 的整段相似度去重僅套用於非增量路徑（見 design 決定 3；增量路徑沿用會誤刪絕大多數輸出）
- [ ] 3.6 確認既有的幻覺濾除（`is_hallucination()`）在增量路徑下仍適用，且不會因暫定文字反覆比對而重複觸發

## 4. 自架 ASR 服務的低延遲端點（主要路徑）

> 使用者主力路徑：`voxnote_asr` 指向的自架服務（`server/`，Docker 部署於本機）。
> 本節與第 5 節為本變更的實作重點，應優先於 `local_whisper` 路徑（第 5b 節）完成。

- [ ] 4.1 於 `server/app.py` 新增低延遲轉錄端點，直接使用 faster-whisper 模型實例，不經 `whisperx.load_model()` 的對齊與 diarization 管線（見 design 決定 4）
- [ ] 4.2 該端點回傳純文字結果，格式需足以供呼叫端做連續結果的前綴比對（對應 spec「連續兩次請求的結果可供一致性比對」）
- [ ] 4.3 確認既有批次端點與 `sync=true` 同步模式的行為、輸出格式完全未變（對應 spec「批次端點不受低延遲端點影響」）
- [ ] 4.4 端點不可用時（模型未載入等）回報可辨識的錯誤，不靜默回退至批次路徑（對應 spec「低延遲端點不可用時的回報」）
- [ ] 4.5 實測並決定低延遲端點與批次端點是否共用同一份模型權重（design Open Question 1；依本機 VRAM 餘裕決定，兩種做法對外契約相同）
- [ ] 4.6 為新端點補上測試（比照 `server/test_app.py` 既有作法）
- [ ] 4.7 確認 Docker 部署下新端點可正常運作（`docker compose up -d --build` 後驗證端點可達）
- [ ] 4.8 確認端點設計不假設部署位置，遠端部署（如 4090 主機）時可直接沿用同一契約

## 5. 主要路徑整合（`voxnote_asr`）

- [ ] 5.1 於 `src-tauri/src/asr/mod.rs` 新增低延遲端點的呼叫函式，與既有的 `transcribe_live_caption_remote()` 並存
- [ ] 5.2 `voxnote_asr` 後端於增量模式下改呼叫低延遲端點，沿用 session 級共用的 `reqwest::Client`
- [ ] 5.3 套用第 2 節的 LocalAgreement 政策，確認端到端可產生暫定／確定文字
- [ ] 5.4 後端不支援增量解碼時，回退至視窗式輸出並告知使用者，不靜默失敗或中止 session（對應 spec「Incremental mode is unavailable for the selected backend」）

## 5b. 次要路徑整合（`local_whisper`）

> 非使用者主力路徑，但仍應盡量即時。政策實作與主要路徑共用（見 design 決定 1），
> 故此節的額外成本主要在解碼觸發時機的調整與實測，可於第 5 節驗證可行後再進行。

- [ ] 5b.1 `local_whisper` 後端於增量模式下維持呼叫 `full()`，由呼叫端控制解碼間隔與分析視窗（見 design 決定 5）
- [ ] 5b.2 套用同一份 LocalAgreement 政策實作，確認與 `voxnote_asr` 路徑行為一致
- [ ] 5b.3 評估是否以 whisper-rs 0.16 已暴露的 VAD（`WhisperVadContext`）取代現行的峰值靜音判定

## 6. 字幕視窗的暫定／確定呈現

- [ ] 6.1 擴充字幕事件的 payload，使前端能區分暫定與確定文字
- [ ] 6.2 於 `overlay.html`／`liveCaptionOverlay.ts` 實作兩種狀態的視覺區分（對應 spec「Tentative text is visually distinguishable from confirmed text」）
- [ ] 6.3 暫定文字被修正時就地更新，不佔用額外的保留段數、不使前一段提前捲離（對應 spec「Tentative text is revised in place」；見 design 決定 6）
- [ ] 6.4 確認既有的固定保留 2 段、貼底裁切、自動清空等行為不受影響
- [ ] 6.5 確認翻譯／校稿的回填機制（同 `sequence` 更新）與暫定文字更新不互相干擾

## 7. 設定介面

- [ ] 7.1 於 `src/components/liveCaptionSettings.ts` 新增增量模式開關與解碼間隔設定項
- [ ] 7.2 說明增量模式的行為取捨（延遲較低但字幕可能先出現暫定內容後被修正），避免使用者誤以為是辨識錯誤

## 8. 實測與調校

- [ ] 8.1 實測 `voxnote_asr` 增量路徑（主力路徑，Docker 自架服務）：記錄「語音發生到暫定文字出現」與「到確定文字」兩個延遲數字，與現行視窗式行為對照
- [ ] 8.2 實測 `local_whisper` 增量路徑（次要路徑），同樣記錄兩個延遲數字
- [ ] 8.3 實測本機負載：確認縮短解碼間隔後 CPU／GPU 可負荷，且 3.3 的略過機制確實生效
- [ ] 8.4 實測準確度：以相同音訊對照「長視窗＋短間隔」與現行「短視窗」的辨識品質，驗證 design 決定 2 的解耦假設成立
- [ ] 8.5 實測暫定文字的跳動程度，評估是否需以靜音偵測作為強制確定的觸發（design Open Question 2）
- [ ] 8.6 依 8.1–8.5 的結果決定解碼間隔與增量模式的預設值（含 1.1 是否改為預設啟用）
- [ ] 8.7 迴歸確認批次逐字稿流程完全未受影響

## 9. 文件

- [ ] 9.1 於專案 README 說明增量模式的行為與取捨，以及解碼間隔與視窗長度的關係
- [ ] 9.2 於 `server/README.md` 說明低延遲端點的用途、與批次端點的差異，以及為何不做對齊與語者分離
