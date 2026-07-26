## Why

語者分離的「預期講者人數」原本是設定頁的一個全域選填欄位，但這在語意上是錯的：每場會議的與會人數不同，全域值無法反映；且使用者在建立會議時已經填過與會人員名單，再要求他到設定頁重複填一次人數是多餘的。人數應直接由該場會議的與會人員數推導。

同時，AssemblyAI 也支援 `speakers_expected` 參數以提升語者分離準確度，先前並未帶入；既然人數已可自動取得，兩個供應商都應受益。

## What Changes

- 移除設定頁的「預期人數（選填）」欄位與對應的 `local_asr_speaker_hint` 設定，人數不再由使用者於設定頁指定。
- 轉錄時自動由該會議的與會人員數（`participants` 筆數）推導預期講者人數。
- `voxnote_asr` 供應商：沿用以 `min_speakers`/`max_speakers` 鎖定人數，來源改為會議與會人員數。
- **AssemblyAI 供應商：新增帶入 `speakers_expected` 參數**（先前未支援），人數同樣取自會議與會人員數。
- 設定頁語者分離說明文字補述「預期人數會自動取自會議的與會人員」。

明確不做（YAGNI）：不提供覆寫人數的手動欄位（與會人員名單即為來源）；不使用 AssemblyAI 的 `speaker_options` 範圍模式（人數已確知，用 `speakers_expected` 即可）。

## Capabilities

### New Capabilities
<!-- 無新增 capability；本 change 調整既有轉錄行為。 -->

### Modified Capabilities
- `local-asr-server`: 預期講者人數的來源由設定頁全域欄位改為該會議的與會人員數。

## Impact

- **Rust 後端**：`src-tauri/src/commands/asr_cmds.rs` 於轉錄前查詢會議取得與會人數並傳入兩個供應商；`src-tauri/src/asr/mod.rs` 的 `transcribe_assemblyai` 新增 `speakers_expected` 參數並帶入 request body、`transcribe_voxnote_asr` 參數改名以反映新來源；`src-tauri/src/config/mod.rs` 移除 `local_asr_speaker_hint` 欄位。
- **前端**：`src/pages/settings.ts` 移除預期人數 UI 與儲存映射、更新說明文字；`src/types/index.ts` 移除對應型別欄位。
- **設定資料**：移除 `local_asr_speaker_hint` 設定鍵；既有 `#[serde(default)]` 會忽略舊 config.toml 中的殘留鍵，無需 migration。
- **外部 API**：AssemblyAI 請求新增 `speakers_expected`（1–20 有效；音檔短於 2 分鐘時該參數會被其忽略）。
