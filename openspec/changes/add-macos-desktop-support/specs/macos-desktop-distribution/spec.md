## Purpose

定義 VoxNote 在 macOS 上可被使用者下載、安裝與執行的發行契約，包含作業系統及架構範圍、未公證安裝限制、核心流程與實機驗證，避免將單純編譯成功誤認為產品已支援。

## ADDED Requirements

### Requirement: macOS releases support Apple Silicon and Intel on macOS 13 or later

系統 MUST 提供適用 macOS 13.0 以上的 Apple Silicon 與 Intel 安裝包，清楚標明架構、版本與最低系統需求。MUST NOT 在缺少驗證時宣稱支援 macOS 12 或更早版本。

#### Scenario: User downloads an architecture-specific release
- **WHEN** 使用者於 v0.1.5 發行頁選擇 arm64 或 x86_64 安裝包
- **THEN** 安裝包 MUST 含對應架構的可執行應用程式，且封裝版本與最低系統需求 MUST 與發行說明一致

### Requirement: macOS distribution explains its signing status accurately

尚無 Apple Developer 帳號時，Mac 發行包 MUST 採 ad-hoc 簽署並明確標示未經 Apple 公證。文件 MUST 說明 macOS 提供的首次開啟流程，MUST NOT 宣稱免警告安裝或要求全域停用 Gatekeeper。

#### Scenario: User opens a downloaded unnotarized build
- **WHEN** 使用者開啟從網路下載的 Mac 版而遇到系統安全性提示
- **THEN** 發行文件 MUST 提供「隱私權與安全性」等系統提供的允許開啟指引，並說明目前的簽署限制

### Requirement: Core meeting workflows operate from the installed macOS app

Mac 安裝版 MUST 支援會議管理、音訊匯入、錄音預覽與儲存、逐字稿編輯、設定、匯出及備份還原。ASR／LLM 在所選服務與模型可用時 MUST 可執行；缺少選用 CLI 工具時 MUST 明確提示，不得阻止其他功能使用。

#### Scenario: User launches from Applications rather than a terminal
- **WHEN** 使用者從 Applications 啟動 App，建立示範會議、匯入音訊並使用已設定的轉錄與摘要服務
- **THEN** 系統 MUST 使用 Mac 使用者資料目錄保存資料，且可完成編輯、匯出與重新啟動後讀取

#### Scenario: Optional local CLI is absent
- **WHEN** 使用者選用外部 Whisper CLI 但該工具不可用
- **THEN** 系統 MUST 顯示工具未設定或找不到的原因，MUST NOT 使行程內本地字幕或其他 ASR 供應商失效

### Requirement: macOS support claims are gated by build and device evidence

正式標示 v0.1.5 支援 Mac 前，MUST 有雙架構建置產物、Apple Silicon 與 Intel 的安裝／核心功能驗證紀錄，以及 macOS 13 最低版本的音訊驗證。README 的新畫面 MUST 來自隔離示範資料的真實 App；未完成的驗證 MUST 保持待完成，不得用 Windows 測試或模擬圖替代。

#### Scenario: Release checklist is incomplete
- **WHEN** 其中一項架構或最低系統版本尚無必要的測試證據
- **THEN** 發布狀態 MUST 保持候選／待驗證，MUST NOT 將所有 Mac 支援任務標為完成
