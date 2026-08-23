## Why

即時字幕目前的延遲下限來自架構本身，而非轉錄速度。實測（2026-08-12，本機 `voxnote_asr`）顯示單次轉錄僅耗時 0.37–0.62 秒，但字幕仍有約 3 秒的感受延遲——因為每個視窗 MUST 先完整填滿才會送出轉錄，「等待視窗填滿」的時間佔了延遲的絕大部分。

縮短視窗長度無法解決此問題：視窗越短，模型可用的上下文越少，辨識準確度隨之下降。這是滑動視窗架構下延遲與準確度的硬性取捨，已於 `add-live-caption-remote-asr` 任務 7.6 確認並記錄。

本變更引入 **LocalAgreement 增量輸出政策**，使步進可縮短至 1 秒以下而不產生字幕閃爍或重複，將延遲與視窗長度解耦。

## What Changes

**主要目標路徑**：`voxnote_asr` 後端指向的自架 ASR 服務（`server/`，以 Docker 部署於本機）。此為使用者當前的主力使用路徑，本變更的實作與調校以此為準。

- 新增**增量式字幕輸出**：以顯著小於視窗長度的步進重複解碼，透過連續兩次解碼結果的共同前綴（LocalAgreement）判定哪些文字已穩定，穩定者即輸出。字幕不再等待整個視窗填滿才更新。
- 新增**暫定（tentative）與確定（confirmed）兩種字幕狀態**：尚未達成 agreement 的文字先以視覺上可區分的方式顯示，達成 agreement 後轉為確定狀態。使用者可更早看到內容，代價是暫定文字可能被修正。
- 將**文字穩定化與字幕列生命週期分離**：LocalAgreement 僅判斷當前段內哪些文字仍可修正，不得決定換段時機。持續語音時字幕 MUST 每 4 秒完成當前段並建立新段，避免已確定文字長時間占住畫面、後文無法成為可保留字幕。
- 字幕歷史改為**依視窗可容納高度保留**：最小視窗仍須同時顯示前一段與當前段；使用者放大視窗時，系統須增加可見歷史段數，而非永遠固定只保留 2 段。
- 新增**自架 ASR 服務的低延遲端點**：於 `server/app.py` 新增繞過 WhisperX、直接使用 faster-whisper 的低延遲端點。既有的批次端點 MUST 維持不變。此為本變更的主要實作重點。
- 擴及 **`local_whisper` 後端的增量解碼路徑**：於 Rust 端在既有 `whisper-rs` `full()` API 之上實作滑動視窗與 LocalAgreement。因 LocalAgreement 政策實作於 Rust 端且與後端無關（見 design 決定 1），此路徑可共用同一份政策實作，額外成本主要在解碼觸發時機的調整與實測。
- 相似度去重機制的適用範圍調整：LocalAgreement 在增量路徑上取代現行的整段相似度去重，現行機制於非增量路徑保留。

**不在本變更範圍**：
- 遠端 4090 主機的部署與調校。自架服務的低延遲端點設計不假設部署位置，遠端部署時應可直接沿用，但本變更不涵蓋其部署與調校。
- 更換模型架構（如 NVIDIA Parakeet／Nemotron 等 transducer 系列）。研究確認此舉將放棄現有的中文 fine-tune 模型，取捨過大，屬另一變更。
- 語者分離、字幕轉發等既有的 Non-Goals 不變。

## Capabilities

### New Capabilities
- `streaming-caption-decoding`: 增量式解碼與 LocalAgreement 穩定化政策——如何從連續音訊產生逐步穩定的字幕文字，包含暫定／確定狀態的判定與轉換規則，以及步進與視窗長度解耦後的參數語意。

### Modified Capabilities
- `live-caption-overlay`: 三項需求的行為改變——
  - `System produces captions incrementally from a continuous audio stream`：現行需求僅要求「視窗填滿後逐段輸出」，須改為允許在視窗填滿前即輸出已穩定的部分文字。
  - `System deduplicates overlapping caption results by similarity`：增量路徑改由 LocalAgreement 處理重疊，須說明兩機制的適用邊界。
  - `System displays captions in an always-on-top floating window`：字幕視窗須能呈現暫定與確定兩種狀態，並以時間式段落輪替及視窗容量保留可閱讀的前文。
- `local-asr-server`: 新增串流端點的契約（繞過 WhisperX 直接使用 faster-whisper），既有批次端點契約不變。

## Impact

**程式碼**
- `src-tauri/src/live_caption/mod.rs`：`process_caption_windows()` 的取樣與輸出迴圈為主要改動點；現行的 `is_duplicate()` 相似度去重需與新政策劃清適用範圍。
- `src-tauri/src/asr/mod.rs`：新增串流端點的呼叫路徑，與既有的 `transcribe_live_caption_remote()` 並存。
- `server/app.py`：新增串流端點，需直接載入 faster-whisper 模型（不經 WhisperX 的對齊路徑）。
- `src/components/liveCaptionOverlay.ts`、`overlay.html`：暫定／確定狀態的視覺呈現。
- `src-tauri/src/config/mod.rs`、`src/types/index.ts`：增量模式的開關與相關參數。

**相依性與風險**
- WhisperX 不支援串流且屬架構性限制（對齊需完整 segment 邊界），故串流端點 MUST 繞過 WhisperX。批次端點續用 WhisperX 不受影響。
- faster-whisper 的 `transcribe()` generator 為惰性求值而非真串流（音訊需先到齊），LocalAgreement 政策 MUST 由呼叫端自行實作。
- `whisper-rs` 0.16 未提供串流 API，Rust 端的滑動視窗與 agreement 邏輯需自行實作；該版本已暴露獨立 VAD（`WhisperVadContext`），可供靜音判定使用。
- 步進縮短會使單位時間內的解碼次數上升，GPU／CPU 負載隨之增加，需實測確認本機環境可負荷。
- LocalAgreement 的共同前綴可能因滑動視窗重複內容而長時間不換段，因此不得以 agreement、標點、字數或舊前綴是否滑出視窗作為字幕列輪替的必要條件。

**既有行為**
- 批次逐字稿流程 MUST 完全不受影響。
- 增量模式應可關閉並回退至現行的視窗式行為，以便在準確度不足時仍有可用路徑。
