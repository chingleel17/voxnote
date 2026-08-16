## Why

語者分離目前有兩種方向相反的錯誤，使用者皆已實際遇到：

**一、該切沒切（多人被歸為同一講者）**。Whisper 依語音停頓與句子完整度切分 segment，切點與講者輪替點不重合，一個 segment 常橫跨換人處。`whisperx.assign_word_speakers` 其實已產生**字級**講者標籤（寫入 `segment["words"][i]["speaker"]`），但 `_to_segments` 僅讀取 segment 層級的 `raw.get("speaker")`（`app.py:406-412`），整段只能有一個標籤，字級資訊在此被丟棄。中文快速一問一答時，換人處的文字會被歸給錯誤講者。

**二、不該拆卻拆了（同一人被判為多個講者）**。pyannote 以 AHC 分群決定講者身分，同一人在音量、語氣、麥克風距離變化或長時間間隔後再發言時，embedding 距離可能超過分群門檻而未被合併，於是一段連續發言被拆成兩個以上講者代號。使用者回報此為目前較困擾的問題——分成多段可以接受，但被歸為不同人會導致發言者判定錯誤。

分群門檻目前完全未暴露：`app.py` 僅傳入 `min_speakers`／`max_speakers`，門檻採模型預設值，使用者無從調整。

兩者必須一併處理。字級切段修正第一類錯誤，但**無法**修正第二類——分群階段已認錯身分，照字級標籤切只會把錯誤切得更整齊。且僅做字級切段會使第二類錯誤在畫面上更明顯：原本整段一個標籤（至少對一半），切細後同一人的發言會散為 A、B、A、B 交錯。

## What Changes

- `_to_segments` 改以字級講者標籤切分：相鄰字的講者不同時切開為獨立分段，時間戳取自該字級區間。
- 字級標籤缺漏時沿用前一字的標籤，不因單一字缺值而中斷或誤切。
- 服務端暴露 pyannote 分群門檻為可設定參數，具明確預設值。
- 覆寫分群參數時保留其餘既有參數，不因部分覆寫而遺失預設值。
- `min_speakers` 是否重新帶入列為可實測選項，預設維持現狀（僅傳 `max_speakers`）。

**不包含**：

- 不改動講者代號 `講者A/B/C` 的正規化與輸出格式。
- 不改動 `asr/mod.rs:491-496` 僅傳 `max_speakers` 的既有策略（見 Design Decisions）。
- 不以 LLM 校正講者標籤。
- 不處理跨錄音段落或跨會議的講者身分（屬 `add-speaker-voiceprint-matching`）。

## Capabilities

### Modified Capabilities

- `local-asr-server`: 語者分離改以字級標籤切分，並暴露分群門檻為可設定參數。

## Design Decisions

### 為何字級切段是決定性修正

字級標籤由 `assign_word_speakers` 已完成計算，本變更僅停止丟棄它。切分規則為純比較（相鄰字標籤是否相同），無機率判斷、無模型推論，同一輸入必得同一輸出。這與 LLM 校稿有本質差異，故不需人工確認流程。

已知限制：切點常落在子句邊界而非精確的輪替點，每次換人可能有一至兩字歸錯。此為 forced alignment 的固有精度限制，非本變更可解；但相較目前整段歸錯，仍為顯著改善。

### 字級標籤缺漏的處理

`assign_word_speakers` 已知會間歇性遺漏部分字的 `speaker` 鍵（whisperX issue #1072），且不可穩定重現。實作 MUST NOT 直接存取該鍵，MUST 於缺漏時沿用前一字的標籤——缺值代表資訊未知，而非講者變更，若視為變更會產生大量錯誤切點。

### 為何門檻覆寫需保留既有參數

WhisperX 的 `DiarizationPipeline` 不暴露分群超參數，其 `__call__` 僅轉發 `num_speakers`／`min_speakers`／`max_speakers`；門檻位於底層 pyannote pipeline（`self.model`）。

pyannote 的 `instantiate()` 需要**完整**參數字典。若僅傳入 `{"clustering": {"threshold": x}}`，其餘既有參數（如 `min_cluster_size`、segmentation 相關參數）可能遺失，造成非預期行為。實作 MUST 先以 `parameters(instantiated=True)` 取得完整參數，覆寫目標鍵後整份傳回。

### 依賴 WhisperX 內部結構的風險

存取 `self.model` 屬 WhisperX 未公開介面，版本升級可能變動。此為取得門檻控制的唯一途徑（上游 issue #1579 已標記 wontfix，明示不打算擴大超參數暴露）。實作 MUST 於取用失敗時安全降級為模型預設值並記錄 log，MUST NOT 因此中斷轉錄。

### 為何不逕自改動 `min_speakers` 策略

`asr/mod.rs:491-496` 僅傳 `max_speakers` 是先前的有意識決定，理由記錄於程式碼註解：單一錄音段落未必所有與會者都發言，鎖定下限會迫使 pyannote 硬拆。

缺少下限約束確實對「一人被拆成多人」不利，但推翻該決定需實測證據。本變更 MUST 維持現狀為預設，並將重新帶入 `min_speakers` 列為實測項目，由實測結果決定是否於後續變更調整。

### 與其他兩個變更的關係

- `add-diarization-confidence-signal`：互補。字級切段依賴詞級對齊產生的字級時間戳；對齊失敗時無字級標籤可用，切段自動退回段落層級行為，而該情境正是可信度提示應出現之時。
- `add-speaker-voiceprint-matching`：互補。本變更以參數調整**預防**過度分割，聲紋變更以相似度**事後合併**已分割的講者。兩者為不同層級的防線，皆需要。

本變更修改 `_to_segments` 與 diarization pipeline 建構，與另兩個變更修改的回應組裝為不同位置，無實作順序相依。

## Impact

**修改既有檔案**

- `server/app.py`：`_to_segments` 改以字級標籤切分；`_ensure_diarize_pipeline` 支援門檻覆寫。
- `server/test_app.py`：字級切分與缺漏處理的測試。
- `server/docker-compose.yml` 與 `server/README.md`：新增環境變數說明。

**不需修改**

- 講者代號正規化規則與 `[MM:SS 講者X]` 輸出格式。
- `asr/mod.rs`：分段數量增加不影響既有解析。
- 前端：分段格式不變。

**相容性**

- 輸出格式不變，僅分段數量與講者歸屬改變；既有客戶端無須調整。
- 門檻未設定時採模型預設值，行為與現況一致。

**驗證需求**

- 需以實際會議錄音（含快速輪替與同一人長時間發言）比較改動前後結果，並記錄建議門檻值。
