# Tasks

## 交付順序與責任

本 change 為第一個端到端基準：先以 mic/system 完成第 1–3 節及必要的 4.3／5.1–5.3 字幕呈現，再完成所有後處理、生命週期與第 6–7 節驗收；最小可運作流程不等於交付。其後交付 process audio，最後進行本地／自架增量剩餘效能調校。共用歷史與 session 正確性在本 change 驗收，不等待其他 change；不改預設後端。

## 1. 設定與串流客戶端基礎

- [ ] 1.1 新增 `assemblyai_streaming` backend 與獨立即時模型設定，同步 Rust/TS；以舊 TOML、設定 round-trip 測試驗證預設值與批次設定不被覆寫。
- [ ] 1.2 建立官方 WebSocket URL/query 與後端認證建構，處理 auto／zh／en 及手動模型 ID；以單元測試驗證 JSON 語言陣列、query 不含永久金鑰及模型設定獨立。
- [ ] 1.3 透過 Cargo CLI 加入 TLS WebSocket client 所需相依套件並建立可注入 transport 的 adapter；以 cargo check 及本機 mock handshake 驗證，保留既有 Cargo 工作樹變更。

## 2. 音訊傳送與服務事件

- [ ] 2.1 實作 mono f32 至 PCM16 little-endian 與 100 ms 封包；測試正負端點、飽和、非有限數值、3,200-byte 封包及尾包補零至 50 ms。
- [ ] 2.2 加入每 100 ms 至多一包、producer/consumer 2 秒 queue 上限、write 1 秒逾時與每 5 秒遺漏提示節流；以假時鐘／阻塞 transport 測試記憶體上限、不加速補播及可取消寫入。
- [ ] 2.3 解析 Begin/Turn/Termination/Error 與非必要 Heartbeat/Ping/Pong；以官方形狀 fixtures 驗證模型核對、未知事件相容、必要欄位錯誤及機密資訊不外洩。
- [ ] 2.4 實作 turn 狀態、暫定／完成／格式化判定與空白抑制，重用共用 OpenCC s2twp 轉換中文顯示文字，不套用 LocalAgreement 或相似度去重；以繁簡混合、英文保留、word 時間不變、重複 final、同 turn 修正、跨 turn 相同短句、完成欄位缺漏／型別錯誤、格式化等候 2 秒及未完成 turn 測試驗證。

## 3. Session、取消與退出

- [ ] 3.1 將新來源接入 manager／既有開始停止 commands，音源與 Begin 皆就緒才 ready；以 mock 驗證 10 秒啟動期限、啟動取消、缺 key 及來源失敗時不遺留 socket。
- [ ] 3.2 共用現有 mic/system queue，分派串流消費器並保留既有視窗解碼路徑；以假 capture 測試不載入本地模型、不探測自架 health 及不驗證不適用視窗參數。
- [ ] 3.3 完成 Terminate→Termination 收尾，ack 2 秒與總停止 5 秒上限，停止時撤銷 producer 入列權限、取出一次性尾端快照且不派發新字幕／LLM；以正常 ack、無 ack、停在 read/write/connect 與停止後 callback 完成的 mock 整合測試驗證。
- [ ] 3.4 實作 15 秒 frame 存活監控及雲端錯誤狀態，不自動重連、重播或切換後端；以斷線、認證、rate limit、無 frame 與音源錯誤測試驗證停止及可手動重啟。
- [ ] 3.5 接入主視窗退出與 180 分鐘 session 上限，明確關閉隱藏 overlay；以假時鐘和關閉主視窗的測試驗證期限及背景 worker 結束。

## 4. 翻譯與字幕事件

- [ ] 4.1 建立串流完成段的可取消後處理 queue（2 個執行中、8 個待處理），溢位保留原文並提示；以延遲假 LLM 測試接收不阻塞、queue 有界與取消生效。
- [ ] 4.2 重用既有翻譯／校稿／同語言 no-op 策略，以 session+turn 去重；測試 partial 不呼叫 LLM、final 只呼叫一次、auto／zh 開關組合及錯誤保留原文。
- [ ] 4.3 擴充字幕及狀態 payload 的 session 身分、revision、phase，同步既有後端發送與 TS 型別；以序列化與舊後端事件測試驗證欄位一致及 source 切換不碰撞。

## 5. 即時字幕介面

- [ ] 5.1 即時頁新增 AssemblyAI 來源、遮蔽的共享金鑰欄及獨立模型建議／手動輸入入口，維持既有原生 select 樣式；以前端建置與 UI 操作驗證保存採用完整目前設定。
- [ ] 5.2 依來源隱藏本地／自架與視窗／LocalAgreement 專屬設定，保留語言、音源、翻譯、校稿及顯示控制；以來回切換測試驗證原值不遺失、變更需重啟提示仍有效。
- [ ] 5.3 overlay 依 session/sequence/revision/phase 就地更新且區分暫定／完成；以可執行的前端事件狀態測試驗證重複、較舊 revision、final 後 partial 與跨 session 遲到譯文。
- [ ] 5.4 開始／停止清空字幕與計時器，晚到譯文不重建已清空／移出段；以自動清空、停止再開始及亂序回填測試驗證，維持既有換行與有限歷史規則。
- [ ] 5.5 所有後端統一容量式歷史（最多 20 段含當前段），以高度／字級變更、超長 turn 的內容區捲動、短 turn 接續及晚到譯文測試驗證；AssemblyAI 不套 4 秒輪替或閱讀等待，本地 4 秒閱讀驗收仍追蹤於增量 change 6b.8。
- [ ] 5.6 驗證所有後端在 stopping 後均不新增字幕／LLM，既有本地 flush 僅內部完成；測試停止與解碼／翻譯完成競態，確認新 session 不受舊結果影響。

## 6. 不需付費服務的整合驗證

- [ ] 6.1 建立 mock WebSocket＋假 capture＋假 LLM 完整 session 測試，覆蓋啟動、音訊、partial/final、停止與錯誤；測試不需 GPU、Whisper、音訊裝置或 API Key，且不呼叫外部服務。
- [ ] 6.2 執行 cargo check、相關 cargo test、npm run build 與前端事件測試；確認所有檢查通過並記錄實際命令，不把只建置成功當成辨識品質驗收。
- [ ] 6.3 驗證本地 Whisper、自架 ASR、錄音互斥與批次設定的回歸，並檢查增量 change 的三路徑條文仍一致；以既有測試及來源切換操作紀錄確認。

## 7. 明確啟用的實際驗收與交付

- [ ] 7.1 使用可分享的中文、英文及中英混用短音訊，各比較 auto 與明確語言；記錄模型、設定、原文準確度、首次出字／final／譯文延遲的 p50/p95，不保存一般使用字幕或金鑰。
- [ ] 7.2 在 Windows 分別驗證麥克風與系統音訊、翻譯開關、停播清空、長 turn、字幕拖曳／縮放／穿透；保留操作與視覺品質結果，確認無重複段落及字幕遺漏提示可見。
- [ ] 7.3 實機驗證正常停止、斷網、主視窗退出與快速停止再開始；確認本地不再送音訊、收到終止或執行有限時間強制清理，且不遺留程序或舊譯文。
- [ ] 7.4 更新既有 README 的即時來源／開發驗證段落，記錄模擬測試命令與實際串流需明確啟用、按連線時間計費；驗證文件不含機密或未實測的品質保證。
- [ ] 7.5 確認所有必要驗收有證據後，執行三份相關 changes 的 OpenSpec strict 驗證，確認重疊 MODIFIED requirements 內容一致後才更新完成項；尚缺帳號或實測音訊的任務保持未完成，不代勾其他 change 或提早封存。
- [ ] 7.6 以可分享的同一組台灣中文、英文及中英混說音訊建立後續比較基準，記錄音訊版本／長度、音源、模型與設定、首次出字／final／譯文 p50/p95、漏字／重複與文字跳動、CPU／記憶體；後續只比較相同音源與語料的結果，不宣稱串流必然更準確。
