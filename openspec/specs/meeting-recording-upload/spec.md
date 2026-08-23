## Purpose

讓使用者可直接在單一會議的詳情頁整理並批次加入多個既有音訊檔，減少重複操作，同時確保誤選檔案能在實際儲存前安全取消。

## Requirements

### Requirement: User can start an audio upload from the meeting page
系統 MUST 在會議詳情頁的錄音區塊提供上傳音訊入口，且無論該會議目前是否已有錄音，使用者皆可在不離開該會議頁面的情況下開始上傳。

#### Scenario: Upload to a meeting with no recordings
- **WHEN** 使用者在尚無錄音的會議詳情頁選擇上傳音訊
- **THEN** 系統 MUST 在目前頁面顯示音訊選擇與待上傳介面，不得導向其他頁面

#### Scenario: Add recordings to a meeting with existing recordings
- **WHEN** 使用者在已有一個以上錄音段落的會議詳情頁選擇上傳音訊
- **THEN** 系統 MUST 在目前頁面顯示待上傳介面，且保留既有錄音段落及其資料

### Requirement: User can build a multi-file upload selection
系統 MUST 允許使用者一次選取多個支援的音訊檔，並在儲存前以待上傳清單呈現選取結果；使用者 MUST 能再次選檔以加入更多項目。

#### Scenario: Select multiple audio files at once
- **WHEN** 使用者在檔案選擇器中選取多個支援的音訊檔
- **THEN** 系統 MUST 將所有選取檔案加入待上傳清單，並顯示可辨識各檔案的原始檔名

#### Scenario: Add another selection to the pending list
- **WHEN** 待上傳清單已有檔案，且使用者再次選取其他音訊檔
- **THEN** 系統 MUST 將新選取檔案加入現有清單，而不是取代先前選取結果

#### Scenario: Cancel the system file picker
- **WHEN** 使用者開啟檔案選擇器後取消，未選取任何檔案
- **THEN** 系統 MUST 保留既有待上傳清單且不得顯示上傳錯誤

### Requirement: User can remove files before saving
系統 MUST 讓使用者在實際儲存前逐一移除待上傳檔案，或取消整次待上傳操作；取消選擇 MUST NOT 刪除來源檔案、既有錄音或建立新的錄音資料。

#### Scenario: Remove one pending file
- **WHEN** 使用者在待上傳清單移除其中一個檔案
- **THEN** 系統 MUST 僅從清單移除該檔案，其他待上傳檔案 MUST 保持不變

#### Scenario: Cancel all pending uploads
- **WHEN** 使用者取消整次待上傳操作
- **THEN** 系統 MUST 清空待上傳清單並關閉該介面，且不得複製任何選取檔案或建立錄音段落

#### Scenario: Last pending file is removed
- **WHEN** 使用者移除待上傳清單中的最後一個檔案
- **THEN** 系統 MUST 將儲存動作設為不可執行，直到使用者再次選取至少一個支援的音訊檔

### Requirement: Selected files are saved as ordered recording segments
當使用者確認儲存時，系統 MUST 依待上傳清單的顯示順序處理檔案，並將成功匯入的音訊接續在該會議既有錄音之後建立為新段落；完成後 MUST 留在同一會議頁並更新錄音區塊。

#### Scenario: Save multiple files successfully
- **WHEN** 使用者確認儲存含多個檔案的待上傳清單，且所有檔案皆成功匯入
- **THEN** 系統 MUST 依清單順序建立對應的新錄音段落、清空待上傳清單，並在目前會議頁顯示更新後的錄音清單

#### Scenario: Upload while existing recordings are present
- **WHEN** 會議已有錄音段落，且使用者成功儲存新的待上傳檔案
- **THEN** 新錄音段落 MUST 接續在既有錄音段落之後，既有段落的順序及內容 MUST 保持不變

#### Scenario: Prevent duplicate submission while saving
- **WHEN** 批次儲存仍在進行中
- **THEN** 系統 MUST 防止使用者再次送出同一批待上傳檔案或修改其清單

### Requirement: Batch upload reports partial failures without duplicating successes
批次儲存中單一檔案失敗 MUST NOT 阻止其他檔案繼續處理。系統 MUST 清楚回報成功與失敗項目，從待上傳清單移除已成功項目，並保留失敗項目供使用者重試或移除。

#### Scenario: One file fails in a batch
- **WHEN** 批次中的一個檔案無法讀取或匯入，而其他檔案成功
- **THEN** 系統 MUST 保留成功建立的錄音段落、繼續處理其餘檔案、只將失敗檔案留在待上傳清單，並顯示成功及失敗數量

#### Scenario: All files fail
- **WHEN** 待上傳清單中的所有檔案皆匯入失敗
- **THEN** 系統 MUST 保留全部待上傳項目供重試或移除，不得建立空白錄音段落，並顯示失敗結果

#### Scenario: Retry failed files
- **WHEN** 使用者在部分失敗後再次儲存仍留在清單中的檔案
- **THEN** 系統 MUST 僅重新處理仍待上傳的失敗項目，不得重複匯入先前已成功的檔案
