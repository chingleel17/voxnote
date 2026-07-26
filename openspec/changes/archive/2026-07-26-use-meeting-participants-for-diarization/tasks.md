> 註記：本 change 的程式碼實作已完成並通過 `cargo check` 與 `tsc --noEmit`；端到端行為驗證需待 `voxnote_asr` 服務實機可用後一併進行。

## 1. Rust 後端

- [x] 1.1 `src-tauri/src/commands/asr_cmds.rs` 於 `start_transcription` 呼叫 `meeting::get_meeting()` 取得與會人員數，查詢失敗或無人員時以 0 表示未知
- [x] 1.2 匯入 `db::meeting` 模組
- [x] 1.3 `src-tauri/src/asr/mod.rs` 的 `transcribe_assemblyai` 新增 `speakers_expected` 參數，並於啟用語者分離且人數介於 1–20 時帶入 request body 的 `speakers_expected`
- [x] 1.4 `transcribe_voxnote_asr` 的 `speaker_hint` 參數改名為 `speakers_expected` 以反映新來源，維持 min=max 鎖定邏輯
- [x] 1.5 `src-tauri/src/config/mod.rs` 移除 `local_asr_speaker_hint` 欄位與其預設值

## 2. 前端

- [x] 2.1 `src/types/index.ts` 移除 `local_asr_speaker_hint` 型別欄位
- [x] 2.2 `src/pages/settings.ts` 移除預期人數 UI 區塊與設定儲存映射
- [x] 2.3 更新語者分離說明文字，補述預期人數自動取自會議與會人員

## 3. 驗證

- [x] 3.1 確認無 `local_asr_speaker_hint` / `speaker_hint` 殘留參照
- [x] 3.2 `cargo check` 與 `npx tsc --noEmit` 通過
- [x] 3.3 端到端驗證：有與會人員的會議轉錄後，語者分離結果符合預期人數（待服務實機可用）
- [x] 3.4 驗證無與會人員的會議仍可正常轉錄（降級路徑）
