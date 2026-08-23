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

確定／暫定是「目前顯示段內文字是否仍可修正」的狀態，MUST NOT 作為字幕段落是否換段、前一段是否繼續顯示或何時配置新 `sequence` 的條件。段落生命週期 MUST 依獨立的顯示週期處理。

#### Scenario: Newly decoded text has not yet been confirmed

- **WHEN** 某段文字剛由解碼產生但尚未通過一致性確認
- **THEN** 系統 MUST 以暫定狀態顯示該文字，且 MUST 使其與確定文字在視覺上可區分

#### Scenario: Tentative text is revised by a later decode

- **WHEN** 後續解碼對同一段語音產生與先前暫定文字不同的結果
- **THEN** 系統 MUST 以新結果取代該暫定文字，MUST NOT 同時保留兩個版本

#### Scenario: Confirmed text is never revised

- **WHEN** 某段文字已進入確定狀態，而後續解碼對該段語音產生不同結果
- **THEN** 系統 MUST 保留原確定文字不變，MUST NOT 修改或撤回已確定的內容

#### Scenario: Confirmed text does not block caption rotation

- **WHEN** 當前顯示段已有確定文字，但後續仍持續產生語音與暫定文字
- **THEN** 系統 MUST 依顯示段落週期完成目前段並開始下一段，MUST NOT 因確定文字仍出現在重疊解碼結果中而持續更新同一個 `sequence`

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

### Requirement: Display segment lifecycle is independent from decoding agreement

系統 MUST 以獨立於解碼間隔與 LocalAgreement 的固定 4 秒顯示週期管理字幕段落。當目前段第一次出現非空文字時，系統 MUST 啟動該段的 4 秒期限；期限到達時 MUST 以當下可用的最佳文字完成該段，並 MUST 為後續文字配置新的遞增 `sequence`。

段落到期時若仍有暫定文字，系統 MUST 將該暫定文字視為該段的最終可用內容，MUST NOT 因等待第二次一致結果而延後換段或丟棄文字。

系統 MUST NOT 以標點、確定字數、共同前綴是否仍存在、舊文字是否已滑出分析視窗，或精確字串前綴是否可扣除，作為到期換段的必要條件。

系統 MUST 以音訊 sample offset 維護已提交游標。每次顯示段完成時，系統 MUST 將游標推進至當下已擷取音訊的末端；下一段 MUST 僅使用游標之後擷取的樣本建立分析 buffer，MUST NOT 再把游標之前的音訊送入解碼。系統 MUST NOT 以精確字串前綴、相似文字或標點推測已完成範圍。即使模型稍微改寫舊文字，也 MUST NOT 將已完成段落重新放入新的當前段。

#### Scenario: Continuous speech rotates captions every four seconds

- **WHEN** 使用者持續說話超過 12 秒且 ASR 持續產生非空結果
- **THEN** 系統 MUST 至少依序完成 3 個顯示段並配置遞增的 `sequence`，MUST NOT 在整段期間只更新同一個字幕列

#### Scenario: Recognition output contains no punctuation

- **WHEN** 連續解碼結果長時間沒有任何標點
- **THEN** 系統 MUST 仍每 4 秒完成目前段並開始下一段，MUST NOT 等待句尾或文字長度門檻

#### Scenario: Old context remains in the sliding window

- **WHEN** 新一次解碼仍包含已完成段落的舊語音，且模型對舊文字有細微改寫
- **THEN** 系統 MUST 在完成段落時推進已提交 sample offset，後續解碼 MUST 僅接收該 offset 之後的樣本，MUST NOT 重新顯示或重新確定已完成段落

#### Scenario: Display segment expires with tentative text

- **WHEN** 目前段的 4 秒期限到達且仍含暫定文字
- **THEN** 系統 MUST 以當下最佳文字完成該段並開始下一段，MUST NOT 延後期限等待 agreement
