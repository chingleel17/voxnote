## Purpose

提供 AssemblyAI 官方串流作為即時字幕來源，讓使用者以既有收音裝置取得暫定及完成字幕，並明確界定音訊傳輸、段落更新、翻譯觸發和連線停止行為，使開發與驗證不依賴本地辨識模型。

## ADDED Requirements

### Requirement: AssemblyAI streaming has independent model and language settings

系統 SHALL 提供 `assemblyai_streaming` 即時字幕後端，由所選共用供應商設定取得 AssemblyAI API Key，並使用獨立於批次的串流模型設定，預設 `universal-3-6-pro`。既有設定檔缺少新欄位時 SHALL 正常載入，原預設後端 SHALL NOT 改變。

系統 SHALL 在設定頁提供可新增多組的語音辨識供應商設定，包含 AssemblyAI、自架 ASR 與本地 Whisper，可建立同類多個具名稱的設定。API Key、URL 與本地模型路徑 SHALL 僅在此處管理；批次 ASR 與即時字幕 SHALL 各自選擇供應商設定及可選模型，並使用同一共用下拉元件。舊金鑰／URL／模型路徑 SHALL 相容遷移，失效的供應商 ID SHALL 明確回報而非靜默切換。

系統 SHALL 使用即時字幕來源語言；auto 時不限制 `language_codes`，明確語言時以 JSON 陣列傳入對應代碼。系統 SHALL 啟用語言資訊回報，SHALL NOT 將批次 API 的自動語言參數語意誤套於串流。即時模型 SHALL 提供建議與手動輸入入口，供應商拒絕或不相容時 SHALL 明確回報，不自動換模型。

#### Scenario: Old configuration loads
- **WHEN** 設定檔未包含 AssemblyAI 串流模型欄位
- **THEN** 系統使用新模型預設值並保留原本後端及批次設定

#### Scenario: Automatic and explicit Chinese language
- **WHEN** 使用者分別以 auto 與中文啟動串流
- **THEN** auto 不傳語言限制，中文使用包含 zh 的語言陣列，兩者都不修改批次語言

#### Scenario: Two services reuse one provider configuration
- **WHEN** 批次 ASR 與即時字幕選取同一 AssemblyAI 設定
- **THEN** 兩服務使用同一金鑰，各自保留所選模型與來源語言，字幕頁不提供重複的金鑰編輯欄

#### Scenario: Multiple self-hosted provider configurations coexist
- **WHEN** 使用者在設定頁新增不同 URL 的自架 ASR 設定，分別供批次與即時字幕選用
- **THEN** 系統保存並按設定 ID 使用正確 URL，不覆寫另一服務的選擇或 URL

#### Scenario: Key or model is invalid
- **WHEN** 金鑰未設定、認證失敗或模型不支援
- **THEN** 系統不進入執行狀態，顯示不含機密資訊的原因並釋放已建立的資源

### Requirement: Streaming startup establishes the official authenticated session

系統 MUST 透過官方 TLS WebSocket v3 端點建立連線，於後端處理認證，MUST NOT 將永久金鑰放入 URL、字幕事件或診斷紀錄。系統 MUST 在音源與服務端 Begin 都就緒後才回報執行中，啟動期限為 10 秒；取消或失敗 MUST 清理音源與連線。

#### Scenario: Successful startup
- **WHEN** 音源可用、金鑰有效且服務送出有效 Begin
- **THEN** 系統進入執行狀態，採用請求的串流模型，且不需要本地模型檔或自架服務

#### Scenario: Startup exceeds its deadline or is cancelled
- **WHEN** 連線／Begin 等待超過 10 秒或使用者取消啟動
- **THEN** 系統停止啟動並回報狀態，關閉已連線的 session，不能留下背景收音或付費連線

### Requirement: Streaming audio is sent at real-time cadence with bounded backlog

系統 MUST 使用 16 kHz 單聲道 PCM16 little-endian binary frame，每包音訊長度介於 50–1,000 ms，正常以 100 ms 節奏傳送且不重疊、不加速補送積壓。連續靜音樣本仍可傳送，MUST NOT 套用 HTTP 靜音視窗略過規則而破壞串流時序。

待傳音訊 MUST 至多累積 2 秒；超過時丟棄最舊樣本並提示字幕遺漏，連續提示頻率 MUST 不超過每 5 秒一次。單包 write 逾時上限為 1 秒；逾時 MUST 結束失效連線，而非無限累積音訊。

#### Scenario: Live audio is captured
- **WHEN** 音源持續產生樣本
- **THEN** 系統以正確格式與即時節奏傳送，不包含 WAV header、Base64 或 JSON 音訊包裝

#### Scenario: Sending cannot keep up
- **WHEN** 網路使待傳音訊超過 2 秒
- **THEN** 系統保留最新音訊、提示遺漏且記憶體不超過上限，不快速重播積壓

#### Scenario: Short trailing audio is flushed
- **WHEN** 正常停止時最後一包不足 50 ms
- **THEN** 系統可補零至 50 ms 後傳送，且收尾仍受停止期限約束

### Requirement: Partial and final turns update one caption segment

同一 `turn_order` 的後續 Turn MUST 覆寫同段，不串接成重複文字。暫定文字 MUST 可與完成文字區分；完成判定 MUST 依有效的服務端完成及格式化標記，不以本地 4 秒計時器或 LocalAgreement 判定。

空白事件 MUST 不產生字幕。不同 turn 的相同短句 MUST 皆保留，MUST NOT 以全文相似度誤刪。

所有模型的非空 Turn MUST 具有 bool 型別 end_of_turn；其為 true 時，turn_is_formatted MUST 存在且為 bool，缺漏或型別錯誤 MUST 立即回報不相容並收尾。兩者都 true 才接受 final；end_of_turn=true 且 turn_is_formatted=false 時 MUST 最多等候同 turn 的格式化完成 2 秒，逾時 MUST 回報模型不相容並結束。模型契約以實際事件驗證，MUST NOT 只由模型名稱推定。已接受的 final 原文 MUST 不被重送或稍後的部分結果改寫。

#### Scenario: A turn is revised multiple times
- **WHEN** 同一 turn 先回傳暫定文字、修正版及完成文字
- **THEN** 字幕在同一段就地更新，不建立三段重複字幕

#### Scenario: Two turns contain the same short sentence
- **WHEN** 兩個不同 turn 都說出相同短句
- **THEN** 系統依 turn 身分顯示兩段，不以文字相似度去重

#### Scenario: An empty closing turn arrives
- **WHEN** 服務端在結束時送出空白 Turn
- **THEN** 系統不新增空白段落，也不對該段呼叫 LLM

#### Scenario: Completion fields are missing or invalid
- **WHEN** 非空完成 Turn 缺少 turn_is_formatted 或該欄位不是 bool
- **THEN** 系統立即回報協定／模型不相容並結束，不將該段送入 LLM

#### Scenario: Formatted completion never arrives
- **WHEN** 非空 end_of_turn=true 且 turn_is_formatted=false 後 2 秒未收到同 turn 的格式化完成
- **THEN** 系統回報模型不相容並收尾，不無限等待或套用本地增量回退

#### Scenario: Completion is already formatted
- **WHEN** 非空 Turn 的 end_of_turn 與 turn_is_formatted 同時為 true
- **THEN** 系統 MUST 立即接受完成段，不進入 2 秒格式化等待

### Requirement: Only completed turns trigger bounded caption postprocessing

完成段 MUST 先顯示原文，再依既有翻譯／校稿選項後處理；暫定、未格式化或未確認段 MUST NOT 呼叫 LLM。每個 session 中同一 turn MUST 至多派發一次後處理，格式化重送不能重複派發。

後處理 MUST 不阻塞音訊與服務端訊息接收；最多 2 個執行中請求與 8 個待處理項目，超限時丟棄最舊待處理項目、保留原文並提示翻譯未跟上。失敗 MUST 保留原文，不中止 ASR。停止後 MUST 不開始新的後處理工作，進行中的結果不得回填已停止 session。

#### Scenario: A final turn is delivered twice
- **WHEN** 同一完成 turn 重送或再次格式化
- **THEN** 系統不再派發第二次 LLM 工作

#### Scenario: LLM is slower than transcription
- **WHEN** 完成段持續抵達且 LLM queue 已達上限
- **THEN** ASR 仍持續接收、queue 保持有界，略過的翻譯保留原文並明確提示

#### Scenario: Translation is disabled or fails
- **WHEN** 翻譯未啟用或請求失敗
- **THEN** 依既有選項顯示原文／校稿結果，不丟失完成段

### Requirement: Chinese streaming text is normalized to Taiwan Traditional Chinese

中文暫定及完成字幕 MUST 在顯示與送入 LLM 前，以共用 OpenCC s2twp 轉換為台灣繁體中文；英文、數字、標點及服務端音訊時間 MUST 保留。系統 MUST NOT 把語言代碼 zh 當成繁體字形保證。

#### Scenario: Provider returns simplified Chinese
- **WHEN** AssemblyAI Turn 回傳簡體或繁簡混合的中文
- **THEN** 字幕及完成段 LLM 輸入使用台灣繁體，不因字詞轉換改變音訊時間資料

### Requirement: Streaming shutdown is explicit and bounded

使用者停止、音源錯誤、啟動取消、服務端錯誤或主視窗關閉時，系統 MUST 停止音訊與新後處理，對仍可寫入的連線送出 Terminate 並讀取到 Termination。等候終止回應最多 2 秒，逾時 MUST 強制釋放 socket；全部串流與音源收尾 MUST 在停止要求後 5 秒內完成。

進入停止狀態後 producer MUST 不再將音訊入列；僅能傳送停止邊界前已擷取且一次性取出的有限尾端音訊，MUST NOT 持續從 capture 取得新樣本。停止期間收到的 final 僅供連線收尾，MUST NOT 恢復字幕或派發 LLM。

運行中 15 秒未收到任何服務端 frame，或 WebSocket 關閉／服務 Error 時 MUST 回報原因並結束。第一版 MUST NOT 自動重連、重播音訊或切換其他後端；使用者可手動重啟。session 最長 180 分鐘，達上限時 MUST 進行正常收尾，不依賴服務自然斷線。

#### Scenario: Normal termination
- **WHEN** 使用者停止串流且服務正常回應
- **THEN** 系統發送 Terminate、接收 Termination 並關閉連線，不繼續送音訊或產生付費 LLM 工作

#### Scenario: Server does not acknowledge termination
- **WHEN** Terminate 後 2 秒仍沒有終止回應
- **THEN** 系統強制釋放連線且整體收尾在 5 秒內完成

#### Scenario: Audio callback finishes after stop was requested
- **WHEN** 停止後仍有先前進入的收音 callback 完成
- **THEN** 該 callback 不得入列，系統只送停止邊界前的尾端快照，不延長 session

#### Scenario: Connection fails during streaming
- **WHEN** 連線中斷、服務回傳 Error 或 15 秒未收到 server frame
- **THEN** 系統結束 session、回報遮蔽機密資訊的原因，僅於使用者手動開始時建立新 session

#### Scenario: Session reaches maximum duration
- **WHEN** session 達 180 分鐘上限
- **THEN** 系統正常終止連線並提示使用者可重新開始

### Requirement: Streaming development tests do not require paid service access

預設測試 MUST 使用模擬 WebSocket／服務事件及可取消的假 LLM，MUST NOT 讀取使用者金鑰或連接付費服務。實際中文／英文音訊驗收 MUST 明確啟用，分別記錄首次字幕、完成段及譯文延遲，並確認停止連線；無實測紀錄不得宣稱辨識品質驗收完成。

#### Scenario: Default tests run offline
- **WHEN** 開發者執行預設測試
- **THEN** 不需 Whisper、GPU、API Key 或外部帳戶即可驗證主要事件與取消契約

#### Scenario: Live service is evaluated
- **WHEN** 明確啟用實際串流驗收
- **THEN** 有中文／英文音訊對照、延遲與停止紀錄，且測試結束不遺留活動連線

#### Scenario: A baseline is retained for later backend comparisons
- **WHEN** AssemblyAI 完成明確啟用的實測
- **THEN** 系統的驗收紀錄 MUST 包含可分享語料的版本、音源、模型、設定、首次出字／完成／譯文延遲及品質與資源觀察，供後續相同語料比較；MUST NOT 將驗收基準解讀為自動更改預設後端
