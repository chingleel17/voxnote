# Tasks

## 交付順序與責任

本 change 為第一個端到端基準：先以 mic/system 完成第 1–3 節及必要的 4.3／5.1–5.3 字幕呈現，再完成所有後處理、生命週期與第 6–7 節驗收；最小可運作流程不等於交付。其後交付 process audio，最後進行本地／自架增量剩餘效能調校。共用歷史與 session 正確性在本 change 驗收，不等待其他 change；不改預設後端。

## 1. 設定與串流客戶端基礎

- [x] 1.1 新增 `assemblyai_streaming` backend 與獨立即時模型設定，同步 Rust/TS；以舊 TOML、設定 round-trip 測試驗證預設值與批次設定不被覆寫。
- [x] 1.2 建立官方 WebSocket URL/query 與後端認證建構，處理 auto／zh／en 及手動模型 ID；以單元測試驗證 JSON 語言陣列、query 不含永久金鑰及模型設定獨立。
- [x] 1.3 透過 Cargo CLI 加入 TLS WebSocket client 所需相依套件並建立可注入 transport 的 adapter；以 cargo check 及本機 mock handshake 驗證，保留既有 Cargo 工作樹變更。
- [x] 1.4 新增共用多組 ASR 供應商設定與兩服務的設定 ID；將舊金鑰、URL、模型路徑相容遷移，以測試驗證同類多設定、批次／即時獨立選擇及無效 ID 不回退。
- [x] 1.5 批次 ASR 與即時字幕開始時按選取 ID 解析連線設定；保留既有三類後端能力、語言／模型獨立性及聲紋功能判斷。

## 2. 音訊傳送與服務事件

- [x] 2.1 實作 mono f32 至 PCM16 little-endian 與 100 ms 封包；測試正負端點、飽和、非有限數值、3,200-byte 封包及尾包補零至 50 ms。
- [x] 2.2 加入每 100 ms 至多一包、producer/consumer 2 秒 queue 上限、write 1 秒逾時與每 5 秒遺漏提示節流；以假時鐘／阻塞 transport 測試記憶體上限、不加速補播及可取消寫入。
- [x] 2.3 解析 Begin/Turn/Termination/Error 與非必要 Heartbeat/Ping/Pong；以官方形狀 fixtures 驗證模型核對、未知事件相容、必要欄位錯誤及機密資訊不外洩。
- [x] 2.4 實作 turn 狀態、暫定／完成／格式化判定與空白抑制，重用共用 OpenCC s2twp 轉換中文顯示文字，不套用 LocalAgreement 或相似度去重；以繁簡混合、英文保留、word 時間不變、重複 final、同 turn 修正、跨 turn 相同短句、完成欄位缺漏／型別錯誤、格式化等候 2 秒及未完成 turn 測試驗證。

## 3. Session、取消與退出

- [x] 3.1 將新來源接入 manager／既有開始停止 commands，音源與 Begin 皆就緒才 ready；以 mock 驗證 10 秒啟動期限、啟動取消、缺 key 及來源失敗時不遺留 socket。
- [x] 3.2 共用現有 mic/system queue，分派串流消費器並保留既有視窗解碼路徑；以假 capture 測試不載入本地模型、不探測自架 health 及不驗證不適用視窗參數。
- [x] 3.3 完成 Terminate→Termination 收尾，ack 2 秒與總停止 5 秒上限，停止時撤銷 producer 入列權限、取出一次性尾端快照且不派發新字幕／LLM；以正常 ack、無 ack、停在 read/write/connect 與停止後 callback 完成的 mock 整合測試驗證。
- [x] 3.4 實作 15 秒 frame 存活監控及雲端錯誤狀態，不自動重連、重播或切換後端；以斷線、認證、rate limit、無 frame 與音源錯誤測試驗證停止及可手動重啟。
- [ ] 3.5 接入主視窗退出與 180 分鐘 session 上限，明確關閉隱藏 overlay；以假時鐘和關閉主視窗的測試驗證期限及背景 worker 結束。

## 4. 翻譯與字幕事件

- [x] 4.1 建立串流完成段的可取消後處理 queue（2 個執行中、8 個待處理），溢位保留原文並提示；以延遲假 LLM 測試接收不阻塞、queue 有界與取消生效。
- [x] 4.2 重用既有翻譯／校稿／同語言 no-op 策略，以 session+turn 去重；測試 partial 不呼叫 LLM、final 只呼叫一次、auto／zh 開關組合及錯誤保留原文。
- [x] 4.3 擴充字幕及狀態 payload 的 session 身分、revision、phase，同步既有後端發送與 TS 型別；以序列化與舊後端事件測試驗證欄位一致及 source 切換不碰撞。

## 5. 即時字幕介面

- [x] 5.1 設定頁新增獨立供應商管理，集中編輯 API Key、URL、本地模型路徑並可新增同類多設定；批次及即時頁只選供應商與模型，一律使用抽出的共用下拉元件；以前端建置及 UI 操作驗證完整設定保存、來源切換及手動模型。
- [x] 5.2 依來源隱藏本地／自架與視窗／LocalAgreement 專屬設定，保留語言、音源、翻譯、校稿及顯示控制；以來回切換測試驗證原值不遺失、變更需重啟提示仍有效。
- [x] 5.3 overlay 依 session/sequence/revision/phase 就地更新且區分暫定／完成；以可執行的前端事件狀態測試驗證重複、較舊 revision、final 後 partial 與跨 session 遲到譯文。
- [x] 5.4 開始／停止清空字幕與計時器，晚到譯文不重建已清空／移出段；以自動清空、停止再開始及亂序回填測試驗證，維持既有換行與有限歷史規則。
- [x] 5.5 所有後端統一容量式歷史（最多 20 段含當前段），以高度／字級變更、超長 turn 的內容區捲動、短 turn 接續及晚到譯文測試驗證；AssemblyAI 不套 4 秒輪替或閱讀等待，本地 4 秒閱讀驗收仍追蹤於增量 change 6b.8。
- [x] 5.6 驗證所有後端在 stopping 後均不新增字幕／LLM，既有本地 flush 僅內部完成；測試停止與解碼／翻譯完成競態，確認新 session 不受舊結果影響。

## 6. 不需付費服務的整合驗證

- [x] 6.1 建立 mock WebSocket＋假 capture＋假 LLM 完整 session 測試，覆蓋啟動、音訊、partial/final、停止與錯誤；測試不需 GPU、Whisper、音訊裝置或 API Key，且不呼叫外部服務。
- [x] 6.2 執行 cargo check、相關 cargo test、npm run build 與前端事件測試；確認所有檢查通過並記錄實際命令，不把只建置成功當成辨識品質驗收。
- [ ] 6.3 驗證本地 Whisper、自架 ASR、錄音互斥與批次設定的回歸，並檢查增量 change 的三路徑條文仍一致；以既有測試及來源切換操作紀錄確認。

## 7. 明確啟用的實際驗收與交付

- [ ] 7.1 使用可分享的中文、英文及中英混用短音訊，各比較 auto 與明確語言；記錄模型、設定、原文準確度、首次出字／final／譯文延遲的 p50/p95，不保存一般使用字幕或金鑰。
- [ ] 7.2 在 Windows 分別驗證麥克風與系統音訊、翻譯開關、停播清空、長 turn、字幕拖曳／縮放／穿透；保留操作與視覺品質結果，確認無重複段落及字幕遺漏提示可見。
- [ ] 7.3 實機驗證正常停止、斷網、主視窗退出與快速停止再開始；確認本地不再送音訊、收到終止或執行有限時間強制清理，且不遺留程序或舊譯文。
- [x] 7.4 更新既有 README 的即時來源／開發驗證段落，記錄模擬測試命令與實際串流需明確啟用、按連線時間計費；驗證文件不含機密或未實測的品質保證。
- [ ] 7.5 確認所有必要驗收有證據後，執行三份相關 changes 的 OpenSpec strict 驗證，確認重疊 MODIFIED requirements 內容一致後才更新完成項；尚缺帳號或實測音訊的任務保持未完成，不代勾其他 change 或提早封存。
- [ ] 7.6 以可分享的同一組台灣中文、英文及中英混說音訊建立後續比較基準，記錄音訊版本／長度、音源、模型與設定、首次出字／final／譯文 p50/p95、漏字／重複與文字跳動、CPU／記憶體；後續只比較相同音源與語料的結果，不宣稱串流必然更準確。

## 共用供應商設定驗證（2026-10-02）

- `cargo test config::providers::tests`：舊 TOML／round-trip、同類多設定獨立解析、失效 ID 不回退皆通過。
- `npm run build`、`npx tsc -p tests/tsconfig.json`：通過。
- 使用目前 Vite dev server 的 `/tests/asr-provider-ui.html` 在 Chromium 執行實際 DOM 操作測試：共用下拉、新增／命名同類設定、獨立 URL、自動儲存、批次／字幕切換、獨立模型及完整最新設定保存皆通過。測試使用假 IPC，不使用 dev app 金鑰、不連接付費服務。
- `openspec validate add-assemblyai-streaming-caption --strict`：通過。
- 2.2／3.1 的 helper 測試已通過，但尚缺原始 capture callback 的有界入列與 manager 啟動取消整合證據，恢復為未完成，待完整驗證後勾選。

## 第二段驗證（2026-10-02）

- Herdr `voxnote-overlay`（`wC:pF`）完成 overlay，主代理以目前 dev server 重跑 `/tests/live-caption-overlay.html`：25 項 Chromium 事件／真實 DOM 版面測試通過，對應 5.3–5.5。
- `cargo test audio_recording::queue::tests`：3 項通過，涵蓋 producer 2 秒上限、錄音預設完整保留、停止後完成的 callback 不入列與一次性尾端快照。
- `cargo test live_caption::lifecycle_tests`：5 項通過，涵蓋雲端不驗證本地／視窗設定、connecting／stopping 音源保留、有限完成等待及停止時 LLM future 不啟動／可取消。
- `npx tsc -p tests/tsconfig.json`、`npm run build` 通過；`/tests/asr-provider-ui.html` Chromium 5 組通過，新增 connecting 取消／恢復操作驗證。

### 最終整合結果

- Herdr `voxnote-stream`（`wC:pG`）提供可注入 transport／事件／LLM 的串流核心與 mock session；主代理完成共用 queue、manager、commands、主視窗退出與前端接線。
- 修正共用收音啟動 reservation、停止命令的 session 身分、停止後 LLM future 再次喚醒的輪詢閘門；本地增量段在完成前維持 partial，校稿保留 ASR 原文快照。
- 主代理重跑 `cargo test`：122 項通過；`cargo check`、`npx tsc -p tests/tsconfig.json`、`npm run build`、`git diff --check` 通過。
- Chromium `/tests/asr-provider-ui.html`：6 組通過；`/tests/live-caption-overlay.html`：26 項通過。新增舊開始回應不停止新 session，以及段內 confirmed 不等於整段 final 的驗證。
- 3.5 的主視窗退出實際 GUI／背景程序證據、4.3／5.6 的既有解碼器完整事件及停止競態、6.3 的實際來源切換／三路徑回歸與第 7 節實測仍保持未完成；mock 通過不代表付費服務的辨識品質已驗收。

## 後續自動驗證閉合（2026-10-02）

- 第二段已提交 `6c97abb`；原 reviewer 對共用音源 reservation、依 session ID 停止、停止後 future 輪詢閘門的三項重驗均確認已解決。
- `src-tauri/src/live_caption/window_tests.rs` 測試同一 production 視窗核心：本地／自架 final 與增量 partial、4 秒完成及後處理 revision、原文快照、去重、session 切換及序列化；停止於解碼中／完成後、增量 flush、LLM 喚醒或失敗均不新派發字幕／工作。對應 4.3、5.6 已完成。
- `cargo test`：129 項通過；`cargo check`、`npx tsc -p tests/tsconfig.json`、`npm run build` 通過。Chromium 供應商頁 6 組、overlay 26 項通過。
- 自架服務以 Python 3.12 的隔離輕量環境執行 `uv run --isolated --no-project --python 3.12 --with "fastapi>=0.115" --with httpx --with numpy --with python-multipart --with opencc-python-reimplemented -- python -m unittest test_app`：36 項通過。測試重設各 scenario 的非同步鎖；假轉錄器驗證批次與增量契約，不載入 GPU／WhisperX 模型、不連接付費服務。
- 串流新增非文字診斷：`ready`／`stopping`／`stopped`、封包數、停止耗時、Terminate／Termination 及 socket 釋放結果、固定錯誤碼。`VOXNOTE_STREAMING_DIAGNOSTICS=1` 才記錄 turn 的首次／完成／後處理時間。正常與無 ACK、限流錯誤測試確認不含金鑰或字幕。
- 完整區塊比對：AssemblyAI 與增量 change 的「持續增量字幕」「相似度去重」「浮動視窗」三個 MODIFIED requirements 及 scenarios 僅排版空白不同，內容一致；process-audio 以 ADDED requirements 引用三路徑，沒有同名 MODIFIED 覆寫。shutdown 的 MODIFIED 僅本 change 持有。
- 待人工證據：3.5 主視窗／隱藏 overlay 及程序退出；6.3 真實本地模型／自架服務／音源切換和錄音互斥；7.1、7.2、7.3、7.6 的 Windows 與語料實測。7.5 需待上述證據齊備後才閉合，不提前 archive，也不代勾其他 change。

## 實機啟動問題修正（2026-10-03）

- 使用者回報 AssemblyAI＋系統音訊啟動後未回報結果，重試被判定仍執行中。`cargo tree -e features -i rustls` 確認原本僅有 `std`，沒有加密 provider；本機 `wss://` fixture 在修正前確實觸發 rustls `CryptoProvider` panic。原 mock 僅測 `ws://`，未涵蓋 TLS 初始化。
- 以 Cargo CLI 加入 rustls `std,ring,tls12`，connector 明確安裝或沿用 process default provider，維持原 TLS 憑證驗證。新增本機 WSS 初始化測試確認握手錯誤正常回傳，不 panic、不需帳戶或外部服務。
- worker 以 panic supervisor 及 RAII 收尾關閉入列、停止旗標與完成通知；已退出但未通知的執行緒可回收，避免永久保留假 active session。新增 panic 後可回收重啟、遺漏完成通知仍可回收的回歸；失敗時亦通知 inactive 狀態與隱藏 overlay。
- `cargo test`：132 項通過；`cargo check` 通過。定向核對未發現誤清仍活著 worker、停用憑證驗證或舊錯誤影響新 session 的已確認缺陷。實際 AssemblyAI 服務仍需重新啟動完整 dev 後重測，不以本機 TLS fixture 代替付費服務驗收。

## 連續收音累積延遲修正（2026-10-03）

- 使用者回報可以辨識，但延遲及音訊佇列捨棄提示持續出現。production mock 以 16 kHz 連續入列、每次晚 20 ms 醒來持續 16.8 秒，在修正前確實重現固定 1,600 samples 封包使佇列累積至上限；不是藉由放大 queue 或略去遺漏提示處理。
- 正常仍使用 100 ms 封包；晚到時按前次實際派送至當下的音訊時間取樣，單包最多 1,000 ms、只取已擷取樣本、每 100 ms 最多一次，不連發補播。啟用 TCP_NODELAY，避免 Nagle 小封包延遲。
- 新增晚醒持續收音、250 ms 寫入持續收音的回歸，確認無持續累積／捨棄且 packet duration、樣本總數與非文字 AudioFlow 計數一致。`cargo test`：134 項通過；`cargo check` 與 OpenSpec strict 通過。
- 每 5 秒 `audio_flow` 記錄累積 captured／sent／dropped samples、目前 pending samples 及 session 最大成功寫入時間。相鄰紀錄差值可協助區分實機擷取速率、排程與網路問題；`max_write_ms` 是 session 累積最大值，並非每區間平均。真實服務延遲與 WASAPI 輸入速率仍由實機重測確認，不以 fake clock 宣稱辨識品質驗收。
- 使用者實機重測 AssemblyAI＋系統音訊後確認「延遲改善，錯誤提示沒有出現」。記為本次累積延遲／佇列捨棄問題的實機改善證據；未提供測試時長、語料版本或 p50/p95 數據，不代勾完整品質、其他音源或停止／退出驗收。
