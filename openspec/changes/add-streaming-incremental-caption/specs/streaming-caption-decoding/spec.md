## Purpose

定義即時字幕如何從連續音訊產生逐步穩定的文字：以小於視窗長度的步進重複解碼，並依連續解碼結果的一致程度判定文字是否已穩定，使字幕延遲不再受限於視窗長度。

## ADDED Requirements

### Requirement: System emits caption text before the analysis window is full

系統 MUST 能在音訊視窗尚未填滿之前即輸出已判定穩定的文字。字幕的輸出時機 MUST NOT 僅取決於視窗是否填滿。

系統 MUST 以顯著小於視窗長度的間隔重複對目前已累積的音訊進行解碼，使新語音進入後能在一個間隔內被納入解碼範圍。

#### Scenario: Speech is emitted while its window is still filling

- **WHEN** 使用者開始說話，且該語音所屬的分析視窗尚未累積至完整長度
- **THEN** 系統 MUST 在視窗填滿之前即輸出該語音中已判定穩定的部分文字

#### Scenario: Decode interval is shorter than the window length

- **WHEN** 增量模式啟用
- **THEN** 相鄰兩次解碼的間隔 MUST 小於分析視窗長度，且新進入的語音 MUST 在一個解碼間隔內被納入解碼範圍

### Requirement: System distinguishes tentative from confirmed caption text

系統 MUST 將字幕文字區分為「暫定」與「確定」兩種狀態。暫定文字為尚未經過一致性確認、後續可能被修正的內容；確定文字為已通過一致性確認、MUST NOT 再被更改的內容。

系統 MUST 使兩種狀態在字幕視窗中可被使用者區分。

文字一旦進入確定狀態，系統 MUST NOT 因後續解碼結果不同而修改或撤回該文字。

#### Scenario: Newly decoded text has not yet been confirmed

- **WHEN** 某段文字剛由解碼產生但尚未通過一致性確認
- **THEN** 系統 MUST 以暫定狀態顯示該文字，且 MUST 使其與確定文字在視覺上可區分

#### Scenario: Tentative text is revised by a later decode

- **WHEN** 後續解碼對同一段語音產生與先前暫定文字不同的結果
- **THEN** 系統 MUST 以新結果取代該暫定文字，MUST NOT 同時保留兩個版本

#### Scenario: Confirmed text is never revised

- **WHEN** 某段文字已進入確定狀態，而後續解碼對該段語音產生不同結果
- **THEN** 系統 MUST 保留原確定文字不變，MUST NOT 修改或撤回已確定的內容

### Requirement: System confirms text by agreement across consecutive decodes

系統 MUST 依連續解碼結果之間的一致程度判定文字是否可進入確定狀態。僅在同一段文字於連續多次解碼中一致出現時，系統才 MUST 將其標記為確定。

系統 MUST NOT 僅依單次解碼結果即將文字標記為確定。

#### Scenario: Consecutive decodes produce the same leading text

- **WHEN** 連續兩次解碼對同一段語音的開頭部分產生一致的文字
- **THEN** 系統 MUST 將該一致的部分標記為確定，並 MUST 將其後尚未一致的部分維持為暫定

#### Scenario: Consecutive decodes disagree

- **WHEN** 連續兩次解碼對同一段語音產生不一致的結果
- **THEN** 系統 MUST NOT 將不一致的部分標記為確定，且 MUST 維持其為暫定狀態直到取得一致結果

#### Scenario: Audio ends while text is still tentative

- **WHEN** 音訊結束或 session 停止時仍有文字處於暫定狀態
- **THEN** 系統 MUST 將該暫定文字輸出為最終內容，MUST NOT 因未取得一致確認而丟棄該文字

### Requirement: Incremental decoding can be disabled in favor of window-based output

系統 MUST 提供關閉增量模式的方式。增量模式關閉時，系統 MUST 回退至以完整視窗為單位的字幕輸出行為，且此時 MUST NOT 產生暫定狀態的文字。

#### Scenario: User disables incremental mode

- **WHEN** 使用者關閉增量模式並啟動即時字幕
- **THEN** 系統 MUST 以完整視窗為單位輸出字幕，且所有輸出的字幕 MUST 皆為確定狀態

#### Scenario: Incremental mode is unavailable for the selected backend

- **WHEN** 使用者選用的轉錄後端不支援增量解碼
- **THEN** 系統 MUST 回退至視窗式輸出並 MUST 告知使用者，MUST NOT 靜默失敗或中止 session

### Requirement: Decode frequency is bounded to protect system responsiveness

縮短解碼間隔會提高單位時間的解碼次數。系統 MUST 限制同時進行的解碼數量，且在解碼耗時超過解碼間隔時 MUST 略過該次解碼，而非無限累積待處理的解碼工作。

#### Scenario: Decoding is slower than the decode interval

- **WHEN** 單次解碼耗時超過設定的解碼間隔
- **THEN** 系統 MUST 略過本應在該期間觸發的解碼，MUST NOT 讓待處理的解碼工作無限累積

#### Scenario: Sustained high load during a session

- **WHEN** 解碼持續慢於解碼間隔達一段時間
- **THEN** 字幕 MUST 持續跟隨當下語音而非逐漸落後，且系統 MUST NOT 因累積的解碼工作而耗盡記憶體
