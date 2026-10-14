# 後台設計提案：讓同行友人填寫說明與心得

> 狀態：**已決定**（2026-10-15）。Viking 選方案 B，並把需求改為「留言＋繪馬」的塗鴉牆形式、只能新增不能修改。
> 定稿的規格與執行方案見 [notes-spec.md](notes-spec.md)；本文件保留作為選型紀錄，第 2 節的「修改提案」流程已不採用。
> 標記：**［事實］** 有檔案或文件依據；**［推論］** 由證據推得、未實測；**［待定］** 需要 Viking 決定。

## 結論

建議採用 **方案 B：Cloudflare Access（Email 驗證碼登入）＋ Worker ＋ D1 投稿箱，Viking 審稿後由本機腳本寫回 YAML**。

理由：

1. 友人不需要 GitHub 帳號，收信輸入驗證碼就能登入。
2. 友人送出的內容先存在 D1，**不會直接改 YAML，也不會出現在公開的 GitHub 倉庫**；Viking 按「通過」才寫回。
3. 可改的欄位由伺服器端白名單控制，友人碰不到排版、時刻、虛化座標。
4. YAML 仍是唯一的正式資料，`npm run check` → `npm run build` → `npm run deploy` 的流程不變。
5. 在免費額度內，成本 0 元。

如果只想讓這一趟旅行的說明快點補齊、不打算長期維護後台，**方案 C（共用試算表＋匯入腳本）** 最省事，今天就能開始。方案 A（Decap CMS）不建議，原因見下文。

---

## 1. 現況與限制

| 項目 | 現況 | 對後台的影響 |
|---|---|---|
| 資料 | 66 件展品 `src/content/exhibits/*.yaml`、5 天排版 `src/content/days/*.yaml`［事實］ | 後台最後一定要改這些檔案 |
| 草稿狀態 | 66 件展品**全部是 `draft: false`**［事實］ | 依鐵則 2，友人對任何一件的標題或說明的修改，都必須經過 Viking 同意，不能直接生效 |
| 心得欄位 | 每天 1 個 `slot`，共 5 個［事實］；`slot` 只在 `npm run dev` 顯示 | 填好要改成 `text` 文字卡（`time` / `title` / `body`） |
| 文字卡結構 | `text` 沒有作者欄位［事實］ | 若每人各寫一張心得，需要新增署名欄位［待定］ |
| YAML 註解 | 展品檔與排版檔都有人寫的註解（例如「2026-10-14 Viking 確認排版」「背景拼貼：…暫用版」）［事實］ | 寫回時必須保留註解；工具會不會吃掉註解是選型重點 |
| 日期引號 | 日期、時刻一定要加引號，否則 Astro 讀成 Date 而通不過 schema［事實：README 6 節］ | 寫回時要保留引號樣式 |
| 部署 | `wrangler.jsonc` 是純靜態資源，沒有 Worker 程式［事實］ | 方案 B 要加一個 Worker；靜態檔仍不經過 Worker |
| 倉庫 | GitHub 公開倉庫［事實］ | 任何在 GitHub 上的草稿（分支、PR）都是公開的 |
| 隱私檢查 | `npm run check` 只檢查媒體 metadata 與引用［事實］ | 文字欄位目前沒有檢查；友人可能寫進全名、電話等 |
| `remarks` | 給維護者的備註，網站沒有顯示［事實］ | 後台不要把 `remarks` 送到前端 |

## 2. 所有方案共用的規則

不論選哪個方案，以下規則都一樣：

### 誰能改哪些欄位

| 欄位 | 友人 | Viking |
|---|---|---|
| 展品 `title`、`note` | 可提出（需 Viking 通過） | 可改、可通過 |
| 每天的心得（`slot` → `text`） | 可寫自己的一張 | 可改、可通過 |
| `place` | 不開放［推論：地名已確認過，改動風險高於好處］ | 可改 |
| `time`、`date`、`media`、`blur`、`crop`、`edit`、`columns`、`backdrop`、`draft`、`remarks` | **不開放** | 照舊用 Claude Code 或手改 |
| 上傳照片 | **不開放**（新素材仍走 `raw/` → `npm run ingest`，才能確保去除 metadata） | — |

### 不覆寫人寫的內容、draft 流程

- 友人送出的是**修改提案**，每筆記錄「原本的值」與「新的值」。
- 寫回時，如果檔案裡現在的值已經不等於提案的「原本的值」（例如 Viking 在這期間改過），**不覆寫，列為衝突**交給 Viking 處理。
- 友人無法把 `draft` 改成 `false`；只有 Viking 通過的內容才寫回並維持 `draft: false`。
- 心得是個人感受：**每個人的心得只由本人寫**（延伸鐵則 1）。Claude 不代寫、不潤飾，寫回時原文照錄。

### 隱私

- 友人只能改文字，不能上傳檔案，所以媒體的隱私檢查不受影響。
- 建議在 `scripts/check.mjs` 加一項文字「提醒」（不擋建置）：掃描 `title` / `note` / 文字卡有沒有 email、電話號碼、LINE ID 樣式的字串［推論：範圍小、容易做，但屬於另一個改動，要 Viking 同意才加］。
- 全名、他人的個資靠 Viking 審稿把關。

---

## 3. 三種方案

### 方案 A：Decap CMS（或 Sveltia CMS）＋ GitHub 登入，直接改 YAML 再重建

**做法**：在網站放 `/admin`，載入 Decap CMS。友人用 GitHub 帳號登入，在表單裡改 `title` / `note`，CMS 用「編輯流程（editorial workflow）」幫每次修改開一個 PR，Viking 在 GitHub 合併後重新建置部署。GitHub 登入需要一個小的 OAuth 代理，可以放在 Cloudflare Worker。

| | |
|---|---|
| 登入 | GitHub 帳號。友人要有 GitHub 帳號，而且要加為倉庫協作者（有寫入權限）才能用一般模式［推論：Decap 的 GitHub 後端需要寫入權限；fork 式的 open authoring 是 beta］ |
| 欄位權限 | CMS 設定只顯示 `title` / `note`，但協作者本身就有整個倉庫的寫入權；真正的保護要靠 `main` 分支保護規則（必須 Viking 審核） |
| 不覆寫／draft | 靠 PR 審核；衝突由 git 處理 |
| 心得 | `slot` 在 `columns` 陣列深處，Decap 要用「多型別清單」才能編輯，等於把整個排版結構攤給友人看，容易誤改［推論］ |
| 隱私 | PR 一開就公開在 GitHub，**友人的草稿在通過前就是公開的** |
| YAML | Decap 重新序列化 YAML，**很可能丟掉註解、改掉引號樣式**［推論，需實測］ |
| 成本 | 0 元 |
| 維護 | 設定檔＋OAuth Worker，程式量最少；但介面是通用 CMS，中文化與手機體驗普通 |
| 自動部署 | 需另外接 Workers Builds 或 GitHub Actions，否則合併後仍要 Viking 手動 `npm run deploy` |

**優點**：現成工具、程式最少、git 歷史完整。
**缺點**：友人要會 GitHub；草稿公開；欄位權限只是介面層；可能破壞 YAML 註解與引號；心得欄位不好做。

**適合**：同行友人都是工程師、習慣 GitHub 的情況。依目前所知［推論］這次不符合。

---

### 方案 B：Cloudflare Access ＋ Worker ＋ D1 投稿箱，審稿後匯出 YAML（建議）

**做法**：

```
友人 ──Email 驗證碼──▶ Cloudflare Access ──▶ /edit/*（填寫頁）
                                          └▶ /api/*（Worker）──▶ D1：submissions
Viking ─▶ /edit/review（審稿頁：通過／退回）──▶ D1 狀態改為 approved
Viking 本機 ─▶ npm run pull-notes ──▶ 讀 D1 已通過的提案 ──▶ 寫回 YAML（保留註解）
           ─▶ npm run build（含 check）──▶ git commit ──▶ npm run deploy
```

1. **登入**：Cloudflare Access 的 One-time PIN：在登入頁輸入 email，收信拿 6 位數驗證碼［事實：Cloudflare 文件］。允許名單寫在 Access 政策裡，只放同行友人的 email。Access 只保護 `/edit*` 和 `/api*`，公開的展覽牆照舊不需登入。
2. **Worker**：`wrangler.jsonc` 從純靜態改成「Worker＋靜態資源」，設定 `run_worker_first: ["/api/*"]`，其餘路徑仍直接由靜態資源回應、不經過 Worker［事實：Cloudflare 文件，Wrangler ≥ 4.20］。Worker 從 Access 取得登入者 email（`ctx.access.getIdentity()`，或驗證 `Cf-Access-Jwt-Assertion` JWT）［事實：Cloudflare 文件］。
3. **填寫頁 `/edit`**：建置時由 Astro 產生一份展品清單（縮圖、編號、目前的標題與說明，不含 `remarks`）。友人點一件展品，看到目前內容，送出新版本；每天的心得各有一個輸入框。手機可用。
4. **D1 資料表 `submissions`**：`id`、`kind`（exhibit / reflection）、`target`（JP-02-11 或 2026-10-06）、`field`（title / note / body）、`base`（送出時看到的原值）、`value`（新值）、`author`（email）、`status`（pending / approved / rejected / exported）、時間戳記。伺服器端只接受白名單內的 `kind` + `field` 組合。
5. **審稿頁 `/edit/review`**：只有 Viking 的 email 能進（Worker 再檢查一次）。逐筆顯示新舊差異，按通過或退回。
6. **寫回 `npm run pull-notes`**（本機腳本）：用 `wrangler d1 execute --remote --json` 讀出已通過的提案，用專案已有的 `yaml@2.8.1` 以 `parseDocument` 改值［推論：Document API 會保留註解與未修改節點的引號樣式，需實測］。`base` 和檔案現值不同就跳過並列出衝突。成功寫回的標記為 exported。之後照現有流程 build → commit → deploy。

| | |
|---|---|
| 登入 | Email 驗證碼，不需任何帳號 |
| 欄位權限 | 伺服器端白名單，友人技術上也改不到其他欄位 |
| 不覆寫／draft | 提案帶原值，寫回時比對；只有 Viking 能通過 |
| 心得 | 獨立的輸入框，寫回時把該天的 `slot` 換成 `text`（多人時插入多張） |
| 隱私 | 草稿只在 D1（Viking 的 Cloudflare 帳號），通過前不公開；`/edit` 頁不給 `remarks` |
| YAML | 由自己的腳本控制，可保留註解與引號 |
| 成本 | 0 元。Workers 免費方案、D1 免費額度（每天讀 500 萬列、寫 10 萬列、總容量 5 GB）［事實：Cloudflare 定價頁］遠超需求；靜態資源請求不計費。Access 免費方案人數上限約 50 人［推論：記憶中的方案內容，文件查詢未找到，建置前要確認］ |
| 維護 | 要寫的東西最多：Worker（API＋權限）、填寫頁、審稿頁、匯出腳本、一張 D1 表；粗估 600～900 行［推論］。Access 與 D1 要在 Cloudflare 後台設定一次 |
| 自動部署 | 第一版不做：通過後仍由 Viking 在本機寫回、建置、部署，保持「部署前一定經過 `npm run check`」 |

**優點**：友人零門檻；草稿不公開；權限在伺服器端；YAML 與現有流程不變；以後的旅行可以重用。
**缺點**：要寫、要維護的程式最多；多一個 Worker 與 D1 要顧；寫回仍需 Viking 在本機執行一步。

**可擴充（第二階段，非必要）**：審稿通過時由 Worker 直接透過 GitHub App 開 PR，再接 Workers Builds 自動部署，就不用在本機跑匯出腳本。代價是要管 GitHub 權杖，而且 PR 會公開（但此時內容已經通過審稿）。

---

### 方案 C：不做後台，共用試算表＋匯入腳本

**做法**：產生一份 Google 試算表，每列一件展品（編號、縮圖、目前標題、目前說明、「你的修改」欄），另一頁是每天的心得（每人一欄）。縮圖可以用 `=IMAGE("https://osaka2026.voriens.dev/media/…")` 顯示，因為網站本來就公開。Viking 用 Google 的分享權限邀請友人。收齊後下載 CSV，用 Claude Code 寫一支匯入腳本，產生 YAML 修改給 Viking 逐筆確認。

| | |
|---|---|
| 登入 | Google 帳號（分享權限） |
| 欄位權限 | 只靠表格欄位約定；任何人都能改整張表 |
| 不覆寫／draft | 匯入時比對「目前標題／說明」欄與檔案現值；Viking 逐筆確認 |
| 心得 | 每人一欄，最直覺 |
| 隱私 | 草稿在 Google 試算表（不公開，但存在 Google） |
| YAML | 匯入腳本控制，可保留註解 |
| 成本 | 0 元 |
| 維護 | 幾乎沒有；只有一支匯入腳本（粗估 100～200 行［推論］） |
| 自動部署 | 無，Viking 手動 |

**優點**：今天就能開始；友人最熟悉；沒有任何伺服器要顧。
**缺點**：不是「在網站上登入」；看不到展品在牆上的樣子；多人同時改同一格會互相覆蓋；以後每趟旅行要重做一次表。

---

## 4. 比較總表

| | A：Decap CMS | B：Access＋Worker＋D1 | C：共用試算表 |
|---|---|---|---|
| 友人登入門檻 | 高（GitHub 帳號＋協作者） | 低（email 驗證碼） | 低（Google 帳號） |
| 欄位權限 | 介面層，靠分支保護 | 伺服器端白名單 | 只靠約定 |
| 草稿是否公開 | **是**（PR 公開） | 否 | 否（存在 Google） |
| 不覆寫的保證 | PR 審核 | 原值比對＋審稿 | 原值比對＋逐筆確認 |
| 心得欄位 | 難做 | 容易 | 容易 |
| 保留 YAML 註解 | 可能不行（待實測） | 可以（待實測） | 可以（待實測） |
| 成本 | 0 | 0（Access 人數上限待確認） | 0 |
| 開發量 | 小 | 大 | 很小 |
| 長期維護 | 中（CMS 升級、OAuth） | 中（Worker、D1、Access） | 幾乎無 |
| 以後旅行重用 | 可以 | 可以 | 每次重做 |
| 符合「登入後台自己填」 | 是 | 是 | 部分 |

## 5. 需要 Viking 決定的事

1. **方案**：A / B / C（建議 B；只求這趟補齊則 C）。
2. **友人寫的說明是否也只寫畫面看得到的事實？** 鐵則 1 是約束 Claude 不編造；友人是當事人，可以寫自己知道的背景（例如「排了 40 分鐘」）。要不要放寬？
3. **心得一人一張還是全團一則？** 一人一張的話，`text` 要加一個署名欄位（例如 `by: 小明`），公開版要不要顯示署名？
4. **已確認（`draft: false`）的說明，友人可以提修改嗎？** 目前 66 件全是 `draft: false`。若不開放，友人只能寫心得，展品說明這一半就沒有作用。建議開放「提案」，由 Viking 通過。
5. **友人名單與 email**（Access 允許名單或試算表分享對象）。
6. **通過後誰部署**：維持 Viking 手動（建議），或做第二階段的自動 PR＋自動部署。

## 6. 選定後的下一步（方案 B 為例）

1. 確認 Access 免費方案的人數上限與 One-time PIN 在 `voriens.dev` 帳號可用。
2. 實測 `yaml` 的 `parseDocument` 改值後，註解與日期引號是否保留（決定寫回腳本的做法）。
3. 依決定的第 3 點調整 schema（文字卡署名欄位）。
4. 實作 Worker、填寫頁、審稿頁、匯出腳本；本機用 `wrangler dev` 的 Access 模擬身分測試。
5. 部署前先問 Viking（對外發布規則）。
