## Context

動機見 proposal.md「Why」。此處僅記錄形塑本設計的既有狀態與外部限制。

**既有實作**

- `live_caption/mod.rs` 的 `process_caption_windows()` 為單執行緒迴圈：累積樣本 → 視窗填滿 → 送出轉錄 → 去重 → emit。每次迴圈取「最新視窗」並丟棄視窗外的舊樣本，故延遲不會累積，穩態延遲 ≈ 轉錄耗時 ＋ 至多一個步進。
- 重疊去重為 `is_duplicate()`：對最近 10 筆結果做子字串重疊度（>0.7）與 Levenshtein 相似比（>0.6）雙重判定，整段命中即整段略過。
- 遠端路徑 `transcribe_live_caption_remote()` 走伺服器的 `sync=true` 契約，單次請求內回傳逐字稿。此路徑指向 `server/` 的自架服務，目前以 Docker 部署於本機——「遠端」指的是 HTTP 呼叫關係而非部署位置，本設計不假設服務跑在哪一台機器。此為使用者當前的主力路徑。

**外部限制（已於 2026-08-12 查證上游原始碼與文件確認）**

- **WhisperX 3.8.6 無串流能力，且屬架構性限制**：`whisperx.align()` 要求完整音訊加上既有的 segment 邊界才能執行強制對齊。對齊是「先有完整邊界」的後處理，與增量式呼叫前提相衝突。上游 issue #1289 自 2025-11 起無維護者回覆，無路線圖。
- **faster-whisper 1.2.1 的 generator 是惰性求值，不是串流**：`transcribe()` 的 `audio` 參數型別為 `str | BinaryIO | np.ndarray`，不接受 iterator；內部先 `decode_audio()` 成完整陣列、再對整段跑 VAD。逐段 yield 只是讓呼叫方早點拿到第一段，音訊仍須先到齊。套件內無任何 stream 類別或方法。
- **whisper-rs 0.16.0 無串流 API**：公開項目中無 stream/sliding 相關型別，crate 的 examples 亦無 stream 範例。whisper.cpp 的 `examples/stream/stream.cpp` 是**應用層**滑動視窗（每步在重疊 buffer 上重跑 `whisper_full()`），不在函式庫內，原始碼自述為 "quick-n-dirty proof of concept"。該版本已暴露獨立 VAD（`WhisperVadContext`、`WhisperVadParams`、`WhisperVadSegments`）。

**此限制的直接後果**：本變更無法「改用串流 API」——該 API 在兩條路徑上都不存在。可行的是在既有的「完整音訊進、完整結果出」介面之上，實作**呼叫端的增量政策**。這是 2025–2026 主流開源方案（ufal/whisper_streaming、WhisperLive、WhisperLiveKit）的共同做法。

## Goals / Non-Goals

**Goals**

- 讓字幕延遲與分析視窗長度解耦：延遲由解碼間隔決定，準確度仍由視窗長度決定。
- 兩條本機路徑（`voxnote_asr` HTTP、`local_whisper` 行程內）皆支援增量輸出。
- 增量模式可關閉並回退至現行視窗式行為。

**Non-Goals（設計層面的額外邊界，proposal 已列的不重複）**

- 不追求逐字（word-level）的即時吐字。本設計的輸出粒度是「連續解碼間已穩定的文字前綴」，通常為數字至一句，不做 token 級串流。
- 不引入 WebSocket 或長連線協定。低延遲端點沿用既有的 HTTP 請求／回應模型，每次解碼一次請求——在本機環境下 HTTP 往返成本遠低於解碼本身（實測轉錄 0.37–0.62 秒），不值得為此引入連線狀態管理。
- 不做跨 session 的模型常駐最佳化（模型載入策略沿用現況）。

## Decisions

### 1. 採用 LocalAgreement-2 作為穩定化政策，而非 AlignAtt

以連續兩次解碼結果的**共同前綴**判定文字是否穩定：兩次解碼對同一段語音的開頭產生一致文字時，該部分標記為確定並輸出；其餘維持暫定。

**理由**：LocalAgreement 只需要「解碼結果的文字」即可運作，對後端完全無侵入——同一套政策可同時套用在 HTTP 端點與 whisper-rs 行程內路徑，這正是本變更需同時支援兩條路徑的關鍵。

**替代方案：AlignAtt（ufal/SimulStreaming）**。已否決於本變更。該政策讀取 encoder-decoder 的 cross-attention 判斷解碼是否逼近 buffer 尾端，論文回報較 LocalAgreement 快約 5 倍。但它需要能存取模型內部的 attention 權重，代表：(a) HTTP 端點需改用 PyTorch 權重而非現有的 CTranslate2 量化權重，VRAM 成本另計；(b) whisper-rs 路徑根本無從取得該資訊。為單一路徑導入第二套政策會使兩條路徑行為分歧，違背「兩條路徑行為一致」的目標。若日後確認 LocalAgreement 的延遲不足，可另開變更評估。

**替代方案：改用 transducer 架構模型（NVIDIA Parakeet／Nemotron 系列）**。已否決。研究確認此舉需放棄現有的中文 fine-tune 模型（伺服器端載入的 `Breeze-ASR-26` 為 whisper-large-v2 的台灣華語 fine-tune），且 whisper.cpp 的 Parakeet 串流支援 PR 已被上游關閉（維護者說明 TDT 架構的 emitted token durations 不適合串流）。取捨遠超出「降低延遲」的範圍。

### 2. 分析視窗與解碼間隔改為獨立參數

現行的 `live_caption_window_seconds`／`live_caption_step_seconds` 語意為「視窗填滿即輸出」，兩者耦合。本設計改為：

- **分析視窗**：每次解碼送入模型的音訊長度，決定模型可用的上下文與準確度。
- **解碼間隔**：兩次解碼的觸發間隔，決定新語音多久被納入解碼、即延遲下限。

解碼間隔 MUST 顯著小於分析視窗（例如視窗 5 秒、間隔 0.8 秒），此時每段語音在被確定之前會被重複解碼數次——這正是 LocalAgreement 取得一致性所需。

**理由**：這是延遲與準確度解耦的核心。現行架構下縮短視窗同時縮短了上下文，兩者一起惡化；分離之後可以「長視窗、短間隔」，同時取得上下文與低延遲。

### 3. 已確定的文字不再經過整段相似度去重

`is_duplicate()` 的整段命中即整段略過，與 LocalAgreement 的前綴累積在語意上直接衝突：增量路徑下，每次解碼的結果本來就與前次高度相似（這是預期行為，不是重複），若沿用會使幾乎所有輸出被誤刪。

**決定**：增量模式啟用時，重疊完全由 LocalAgreement 的前綴比對處理，`is_duplicate()` 不套用於該路徑。增量模式關閉時維持現行行為不變。

### 4. 伺服器端新增獨立的低延遲端點，繞過 WhisperX

於 `server/app.py` 新增端點，直接持有 faster-whisper 的模型實例（不經 `whisperx.load_model()` 的對齊與 diarization 管線），回傳純文字。

**理由**：見 Context 的外部限制——WhisperX 的對齊無法在增量前提下運作。繞過它是必要條件，不是最佳化選項。批次端點續用 WhisperX 不受影響，兩者可共存於同一服務實例。

**模型實例的取捨**：低延遲端點與批次端點是否共用同一份權重需於實作時確認。共用可省 VRAM，但批次的長音訊解碼會阻塞即時請求；分開則 VRAM 加倍。本機環境的 VRAM 餘裕未知，故列為實作階段的實測項目而非此處的預設決定。

### 5. whisper-rs 路徑在既有 `full()` 之上自行實作滑動視窗

whisper-rs 0.16 無串流 API，故 Rust 端維持呼叫 `full()`，改由呼叫端控制「每隔解碼間隔、對最近的分析視窗音訊呼叫一次」，並在其上套用同一套 LocalAgreement 政策。

**理由**：這與 whisper.cpp `stream` 範例的做法同構，且該範例本身就在函式庫之外——代表上游也認為這屬應用層職責。0.16 已提供的獨立 VAD 可用於靜音判定，不需自行實作。

### 6. 暫定文字以就地更新方式呈現，不佔用保留段數

字幕視窗現行保留固定 2 段。暫定文字若被當成新的一段，會使前一段提前捲離，破壞既有的「使用者來得及讀完前一段」需求。

**決定**：暫定文字附加於當前這一段的尾端並就地更新，確定後才固化；段落的切換時機不因暫定文字的修正而改變。事件層面沿用既有的 `sequence` 機制——同一 `sequence` 的後續事件視為對該段的更新，這與現行翻譯／校稿完成後回填的做法一致，不需新增事件通道。

## Risks / Trade-offs

- **解碼頻率上升導致本機負載過高** → 解碼間隔縮短使單位時間解碼次數成倍增加。緩解：spec 已要求限制同時進行的解碼數並在超時時略過該次解碼（`streaming-caption-decoding` 的「Decode frequency is bounded」）；解碼間隔設為可調，實測後決定本機可負荷的預設值。
- **LocalAgreement 對「說一次就不再重複」的短語反應慢** → 需連續兩次解碼一致才確定，若某段語音只在一次解碼中出現（例如語者立即停頓且視窗已滑過），該文字可能遲遲不被確定。緩解：spec 已要求 session 結束時將暫定文字輸出為最終內容；另可考慮以靜音偵測作為強制確定的觸發條件（實作階段評估）。
- **暫定文字頻繁跳動影響閱讀** → 使用者已明確接受此取捨（延遲低優先）。緩解：暫定文字視覺上與確定文字區分，使用者可自行判斷是否等待；增量模式可關閉。
- **兩條路徑的政策實作分歧** → 政策邏輯若在 Rust 與 Python 各寫一份，容易行為不一致。緩解：政策完全在 Rust 端實作（HTTP 端點只負責回傳文字），伺服器不參與 agreement 判定，故僅有一份實作。
- **低延遲端點與批次端點爭用 GPU** → 批次長音訊解碼期間，即時請求可能被拖慢。緩解：列為實作階段的實測項目（見決定 4），必要時分開模型實例或加入請求優先權。

## Open Questions

- 低延遲端點與批次端點是否共用同一份模型權重？取決於本機 VRAM 餘裕，需實測。此問題不影響 spec 與任務拆解——兩種做法的對外契約相同，僅為端點內部的資源配置。
- 是否需要以靜音偵測作為暫定文字的強制確定觸發？屬政策的細部調校，可於實測 LocalAgreement 的實際表現後決定，不影響架構。
