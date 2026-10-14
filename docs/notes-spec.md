# 留言與繪馬：規格書與執行方案

> 狀態：**規格定稿，等待實作**（2026-10-15）。本文件只有規格，沒有程式；實作由其他工作階段依第 10 節分段進行。
> 前身：[admin-design.md](admin-design.md)（三方案比較，Viking 選定方案 B）。
> 標記：**［決定］** Viking 已決定；**［預設］** 本文件先定的做法，Viking 可推翻；**［待驗證］** 實作時要先實測的技術前提。

---

## 1. 目標

讓同行六人（含 Viking）像塗鴉牆一樣，在展覽牆上留下自己的話：

1. **留言**：對任何一件展品寫心得或註解；別人可以回覆，像對話一樣接下去。
2. **繪馬**：針對某一天寫一塊「繪馬」，像展品一樣掛在當天的牆上。繪馬也可以被留言回覆。

### Viking 的決定（2026-10-15）

| # | 決定 |
|---|---|
| 1 | 採用方案 B：Cloudflare Access 登入＋Worker＋D1，寫回 YAML |
| 2 | 塗鴉牆形式：對任何展品留言；也可以針對某一天寫獨立的文字方塊，和圖片一樣展示 |
| 3 | 每個人都能寫；署名由填寫的人自己決定 |
| 4 | **不可修改既有內容，只能新增**，讓內容像對話一樣延續 |
| 5 | 團體共六人，email 由 Viking 另外確認 |
| 6 | 部署由 Viking 處理 |
| 7 | 單純的文字方塊用**繪馬**的樣子掛在牆上 |
| 8 | 本工作階段只產出方案與規格，實作由其他工作階段完成 |

### 不做的事

- 不開放修改展品的 `title` / `note` / `place` 或任何既有欄位（決定 4）。
- 不開放上傳照片或短片。新素材仍走 `raw/` → `npm run ingest`，才能確保去除 metadata。
- 不自動部署（決定 6）。
- 不做按讚、通知、即時聊天。

---

## 2. 名詞

| 名詞 | 意思 |
|---|---|
| 留言（comment） | 掛在某件展品或某塊繪馬底下的一段話，可以指定回覆哪一則留言 |
| 繪馬（ema） | 掛在某一天牆上的一塊木牌，內容是一段話 |
| 投稿（post） | 留言或繪馬的統稱；D1 裡的一筆資料 |
| 編寫頁 | `/edit/`，登入後看到的展覽牆，多了留言與掛繪馬的功能 |
| 收稿 | Viking 在本機執行 `npm run notes:pull`，逐筆決定是否展出，展出的寫成 YAML |

---

## 3. 規則

### 3.1 只能新增，不能修改［決定］

- 任何人都不能修改或刪除展品、排版、別人的投稿。
- **自己的投稿**：在 Viking 收稿前可以撤回［預設］；收稿後就不能改，想更正就再留一則回覆［預設］。
- 收稿只會**新增**檔案 `src/content/notes/<編號>.yaml`，不會改動 `exhibits/` 和 `days/` 的任何檔案。鐵則 2「不覆寫人寫的內容」在結構上就成立，也不會有 YAML 註解被洗掉的問題。
- 收稿腳本寫檔前檢查檔案是否已存在；已存在就跳過並報錯，絕不覆寫。

### 3.2 只有本人能寫自己的話

- 投稿內容**原文照錄**。Claude 不代寫、不潤飾、不改錯字、不補標點（延伸鐵則 1）。
- 不產生示範用的假留言。測試資料只放在測試用的分支或暫存目錄，`by` 填「測試」、內文以「（測試）」開頭，**不得合併進 `main`**。

### 3.3 署名［決定］

- 每則投稿有一個署名欄 `by`，由寫的人自己填，可以是本名、暱稱，也可以留白。
- 留白時網站顯示「無署名」［預設］。
- 編寫頁會記住上次填的署名（`localStorage`，需 try/catch），下次自動帶入，可以改。
- **登入用的 email 只存在 D1，絕不寫進 YAML、不出現在網站上**。倉庫是公開的。

### 3.4 誰看得到什麼

| 狀態 | 公開網站 | 編寫頁（六人） | 說明 |
|---|---|---|---|
| 待收稿 `pending` | 不顯示 | 所有人可見，標「待展出」 | 讓對話在展出前就能接下去 |
| 已展出 `published` | 下次部署後顯示 | 可見 | 已寫成 YAML |
| 未採用 `rejected` | 不顯示 | 只有作者本人可見，標「未展出」 | |
| 已撤回 `withdrawn` | 不顯示 | 不顯示 | |

### 3.5 收稿把關［預設］

部署由 Viking 處理（決定 6），所以把關放在收稿這一步：Viking 逐筆看過，決定展出或不採用。不採用的內容不會進 Git，也就不會進公開倉庫。這一步主要是為了隱私（全名、電話、他人資訊），不是審查意見。

### 3.6 長度與格式［預設］

| 欄位 | 限制 |
|---|---|
| 留言 `body` | 1～300 字，純文字，可換行 |
| 繪馬 `body` | 1～300 字，純文字，可換行 |
| 署名 `by` | 0～20 字 |
| 每人每天投稿上限 | 100 則（只防誤觸連送） |

所有文字一律當純文字輸出（跳脫 HTML），不支援連結與 Markdown。

---

## 4. 資料模型

### 4.1 YAML：新 collection `notes`（正式資料，進 Git）

一則投稿一個檔案：`src/content/notes/<編號>.yaml`。

```yaml
# 由 notes:pull 產生。內容為投稿者原文，不得修改
kind: comment              # comment（留言）或 ema（繪馬）
target: "JP-02-11"         # comment：展品編號或繪馬編號；ema：日期 "2026-10-06"
replyTo: null              # comment 才有：回覆的留言編號，沒有就是 null
by: "小明"                 # 署名，可以是空字串
body: "這頂帽子後來忘在電車上。"
posted: "2026-10-16T21:03:00+08:00"   # 投稿時間（伺服器時間），加引號
```

> 上面的 `by` 與 `body` 只是格式示意，不是真實投稿。

**schema（`src/content.config.ts`）**：

| 欄位 | 型別 | 規則 |
|---|---|---|
| `kind` | `'comment' \| 'ema'` | 必填 |
| `target` | string | `ema` 時必須是日期格式；`comment` 時必須是 `JP-` 開頭的展品編號或 `n-` 開頭的繪馬編號 |
| `replyTo` | string \| null | 只有 `comment` 可以有；必須是同一個 `target` 底下的另一則留言 |
| `by` | string | 0～20 字 |
| `body` | string | 1～300 字 |
| `posted` | string | ISO 8601 含時區，加引號（YAML 日期陷阱，見 README 6 節） |

**編號**：`n-<YYYYMMDD>-<4 碼小寫英數>`，例如 `n-20261016-7k2q`。投稿當下由 Worker 產生，D1 與 YAML 用同一個編號，從頭到尾不變［預設］。

### 4.2 繪馬掛在哪裡

排版是策展決定（鐵則 4），但 Viking 已經要處理部署，不該每塊繪馬都要手動排。所以：

- **預設位置**：沒有特別安排的繪馬，自動掛在當天最後面的「繪馬掛所」欄（依投稿時間排列）。
- **指定位置**：`days/*.yaml` 的欄位項目新增一種 `- ema: n-20261016-7k2q`，Viking 想移到哪一欄就寫在哪一欄；有指定的就不會出現在繪馬掛所。
- `columnItem` 的 union 增加 `z.object({ ema: z.string() })`。

### 4.3 D1：資料庫 `osaka2026-notes`，資料表 `posts`

```sql
CREATE TABLE posts (
  id          TEXT PRIMARY KEY,          -- n-20261016-7k2q，與 YAML 檔名相同
  kind        TEXT NOT NULL CHECK (kind IN ('comment', 'ema')),
  target      TEXT NOT NULL,
  reply_to    TEXT,
  by          TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,             -- 登入 email，只存在這裡
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'published', 'rejected', 'withdrawn')),
  posted_at   TEXT NOT NULL,             -- ISO 8601
  decided_at  TEXT                       -- 收稿（展出或不採用）的時間
);
CREATE INDEX posts_status ON posts (status);
```

schema 檔放 `worker/schema.sql`，用 `wrangler d1 execute --remote --file` 建立。

---

## 5. 系統架構

```
                     ┌──────────── Cloudflare Access（Email 驗證碼，允許名單 6 人）────────────┐
友人瀏覽器 ── /edit/* ┤  靜態頁（Astro 建置的編寫版展覽牆）                                      │
           ── /api/* ┤  Worker ── D1 posts                                                      │
                     └───────────────────────────────────────────────────────────────────────────┘
一般訪客 ──── /、/media/* ── 靜態資源（不經過 Worker，不需登入）

Viking 本機：npm run notes:pull ── 讀 D1 待收稿 ── 逐筆展出／不採用 ── 寫 src/content/notes/*.yaml
           ── 更新 D1 狀態 ── npm run build（含 check）── git commit ── npm run deploy
```

### 5.1 Cloudflare 設定（Viking 在後台做一次）

1. Zero Trust → Identity providers：新增 **One-time PIN**。
2. Zero Trust → Access → Applications：新增 self-hosted 應用，網域 `osaka2026.voriens.dev`，路徑兩條：`/edit` 與 `/api`（含底下所有路徑）。
3. 政策：Allow，Include → Emails，填六人的 email（決定 5，Viking 確認後填）。
4. 建立 D1 資料庫 `osaka2026-notes`，執行 `worker/schema.sql`。
5. ［待驗證］Access 免費方案人數上限（記憶中約 50 人）。
6. ［待驗證］Access 以路徑保護時，`/edit/*` 的**靜態資源**也會被擋在登入後面（Access 在邊緣節點先於 Worker 與靜態資源執行，推論應該成立）。

### 5.2 `wrangler.jsonc` 變更

- 加上 `main: "worker/index.ts"`。
- `assets` 加 `binding: "ASSETS"`、`run_worker_first: ["/api/*"]`。其餘路徑照舊直接由靜態資源回應，不經過 Worker、不計費。（需要 Wrangler ≥ 4.20；`npm run deploy` 已用 `wrangler@4`。）
- 加 `d1_databases` 綁定 `DB`。
- 環境變數 `EDITORS`：六人 email，以逗號分隔（第二道防線，Access 政策是第一道）。
- 檔頭註解「純靜態網站：不需要 Worker 程式」要改掉。

---

## 6. API 規格（Worker）

每個 `/api/*` 請求都要：

1. 取得 Access 身分：`ctx.access.getIdentity()`；拿不到就驗證 `Cf-Access-Jwt-Assertion` JWT（`jose`，issuer 為 team domain、audience 為應用的 AUD）。失敗回 `401`。［待驗證］自訂網域加路徑型 Access 應用時 `ctx.access` 是否可用；不可用就走 JWT。
2. email 必須在 `EDITORS` 裡，否則 `403`。
3. 寫入類請求（POST、DELETE）檢查 `Origin` 必須是 `https://osaka2026.voriens.dev`，`Content-Type` 必須是 `application/json`，否則 `403`。

| 方法與路徑 | 用途 | 回應 |
|---|---|---|
| `GET /api/me` | 目前登入者 | `{ email }` |
| `GET /api/posts` | 編寫頁要顯示的投稿 | `pending` 與 `published` 的全部，加上自己的 `rejected`。每筆附 `mine: true/false`，**不回傳別人的 email** |
| `POST /api/posts` | 新增投稿 | body：`{ kind, target, replyTo?, by, body }`；成功回 `201` 和完整一筆 |
| `DELETE /api/posts/:id` | 撤回自己的投稿 | 只有作者本人、而且 `status = 'pending'` 才行，狀態改成 `withdrawn`（不真的刪資料）；其他情況 `403` / `409` |

**POST 驗證**（全部在伺服器端，前端驗證只是方便）：

- `kind`、長度限制照 3.6 節。
- `target` 必須存在：建置時輸出 `dist/edit/targets.json`（所有展品編號與日期），Worker 用 `env.ASSETS.fetch` 讀取；繪馬編號則查 D1，狀態必須是 `pending` 或 `published`。
- `replyTo` 必須是同一個 `target` 底下、狀態為 `pending` 或 `published` 的留言。
- 去掉控制字元（換行保留），前後空白修掉。
- 編號在伺服器端產生；`posted_at` 用伺服器時間。
- 超過每人每日上限回 `429`。

本機開發：`wrangler dev` 搭配 `wrangler.jsonc` 的 `access.dev` 區塊模擬登入身分（Cloudflare 文件有此功能）；`astro dev` 用 Vite 的 `server.proxy` 把 `/api` 轉給 `wrangler dev`。

---

## 7. 前端規格

### 7.1 公開網站（`/`）

**展品上的留言**

- 牆上：有留言的展品，在圖說旁顯示一張小紙籤和留言數（例如「籤 3」的樣子，不用 emoji）。
- 說明卡：在說明文字下方加「留言」區，依時間排列。每則顯示署名（或「無署名」）、投稿日期、內文。回覆別人的，上方顯示一行「回覆 ○○：前 20 字…」，點了捲到那一則。
- 閱讀模式：展品下方顯示留言數，內容一樣在說明卡裡看。

**繪馬**

- 樣子：五角形木牌（上方兩角斜切），上緣有孔，用紅繩掛在一根釘子或橫木上。內文直接寫在木牌上，右下角是署名。
- 每塊依編號計算一個固定的小角度（-3°～3°），看起來是一塊塊掛上去的，重新整理也不會變。
- 「繪馬掛所」欄：頂端一根橫木，繪馬由上往下、略微重疊排列。欄寬沿用一般欄位（預設 240px）。
- 點繪馬會打開說明卡：顯示全文、署名、日期，以及它底下的留言。說明卡的 ← → 逐件瀏覽**包含繪馬**，順序依牆上位置。
- 平面圖（minimap）要能看到繪馬的區塊［待驗證：看 `buildMap()` 是否從 DOM 取位置；若是，可能不用改］。
- 背景拼貼在繪馬後面，繪馬不透明。

**色彩與字體**（鐵則 5：淺色、深色、手機 400px 都要支援；動手前先比對 `prototype/index.html`）

| 變數 | 淺色 | 深色 | 用途 |
|---|---|---|---|
| `--ema-wood` | 淺木色（約 `#D8B98C`） | 深木色（約 `#7A5A3A`） | 木牌底色，可加細微木紋漸層 |
| `--ema-edge` | 稍深的木色 | 稍亮的木色 | 木牌邊緣 |
| `--ema-ink` | `#1C1A18`（同墨色） | `#F2EBDD` | 木牌上的字 |
| `--ema-cord` | `#C2332A`（同強調紅） | 同左，略降亮度 | 紅繩 |

- 字體沿用 Noto Serif TC，不新增字型［預設］。若想要手寫感，可以試 Google Fonts 的 LXGW WenKai TC，但要先確認繁體字涵蓋率與檔案大小，由 Viking 決定。
- 手機 400px：繪馬掛所一列兩塊；頁面本體不可以橫向溢出。

### 7.2 編寫頁（`/edit/`）

- **與公開網站是同一面牆**：Astro 用同樣的元件多建一頁 `/edit/`，加上編寫功能。友人看到的就是真正的展覽牆，直接在牆上留言、掛繪馬。
- 編寫頁的 `<head>` 加 `noindex`。
- 載入後呼叫 `GET /api/posts`，把還沒展出的投稿畫上去（標「待展出」，虛線外框），和已經在 YAML 裡的合併；同一個編號只出現一次。
- 說明卡的留言區下方有輸入框：署名（自動帶入上次的）、內文、送出。每則留言旁有「回覆」。
- 每一天的開頭（日期刻度旁）有「掛一塊繪馬」按鈕：彈出輸入框，邊打字邊預覽木牌的樣子，顯示剩餘字數。
- 自己還沒展出的投稿旁有「撤回」，要再確認一次。
- 送出失敗（網路、401、429）要顯示原因，輸入的內容保留不清掉。
- 送出前的內文可以存成草稿（`localStorage`，需 try/catch），重新整理不會不見。
- 頁首顯示目前登入的 email 和一行說明：「你寫的內容會先給 Viking 確認，下次更新網站時展出；送出後不能修改，可以撤回或再留言補充。」

---

## 8. 收稿腳本 `npm run notes:pull`

`scripts/notes-pull.mjs`，Viking 在本機執行（也可以請 Claude Code 代為執行）。

| 用法 | 動作 |
|---|---|
| `npm run notes:pull` | 列出所有 `pending` 投稿（編號、種類、對象、署名、全文、作者 email），不做任何改變 |
| `npm run notes:pull -- --publish <編號,…>` | 把這些投稿寫成 `src/content/notes/<編號>.yaml`，D1 狀態改成 `published` |
| `npm run notes:pull -- --publish-all` | 全部 `pending` 都展出 |
| `npm run notes:pull -- --reject <編號,…>` | D1 狀態改成 `rejected`，不寫檔 |

規則：

- 用 `npx --yes wrangler@4 d1 execute osaka2026-notes --remote --json --command …` 讀寫 D1。
- 寫檔用 `yaml@2.8.1`，日期與時間字串一定加引號；寫完用 schema 驗一次。
- 檔案已存在就跳過並報錯，**絕不覆寫**。
- **相依順序**：回覆或留言的對象（另一則留言、繪馬）必須已經展出或同一批展出；否則這一則先保留在 `pending`，並列出原因。
- **撤銷相依**：若某則被 `--reject`，回覆它的留言要列出提醒（不自動處理，由 Viking 決定）。
- 結束時印出新增的檔案清單，提醒下一步：`npm run dev` 看一次 → `npm run build` → commit → `npm run deploy`。
- 腳本不 commit、不部署。

---

## 9. 隱私檢查（`scripts/check.mjs` 新增）

| 檢查 | 等級 |
|---|---|
| `notes` 的 `target` / `replyTo` 指向的東西存在、`kind` 與 `target` 格式一致 | 錯誤（擋建置） |
| `days/*.yaml` 的 `- ema:` 指向存在的繪馬、同一塊不掛兩次 | 錯誤 |
| `notes` 內文或署名出現 email、電話號碼（台灣手機 `09` 開頭 10 碼、`+81`、`0X-XXXX-XXXX` 等）、`@` 開頭的帳號 | 錯誤（倉庫與網站都公開；不採用或請本人重寫） |
| `notes` 檔案裡出現 `author` 或任何 email 欄位 | 錯誤 |
| 長度超過 3.6 節的限制 | 錯誤 |

媒體檢查不變（友人不能上傳檔案）。

---

## 10. 執行方案（分段實作）

每段由一個工作階段完成，各自開分支、各自驗收。第 1、2 段改的檔案不重疊，可以同時進行；第 3 段要等 1、2 完成；第 4 段要等 1、2 完成。

| 段 | 內容 | 主要檔案 | 依賴 |
|---|---|---|---|
| 1 | 資料模型與公開網站呈現 | `src/content.config.ts`、`src/lib/wall.ts`、`src/components/`（新增 `Ema.astro`）、`src/scripts/wall.ts`、`src/styles/wall.css`、`scripts/check.mjs` | 無 |
| 2 | Worker、D1、API | `worker/`（新增）、`wrangler.jsonc`、`package.json`（加 `jose` 等） | 無 |
| 3 | 編寫頁 `/edit/` | `src/pages/edit/`、`src/scripts/edit.ts`（新增）、`astro.config` 的 proxy | 1、2 |
| 4 | 收稿腳本 | `scripts/notes-pull.mjs`、`package.json` | 1（YAML schema）、2（D1 schema） |
| 5 | Cloudflare 設定與上線 | Cloudflare 後台（Viking）、`README.md`、`CLAUDE.md` | 1～4 |

### 第 1 段：資料模型與公開網站呈現

- 新增 `notes` collection 與 `columnItem` 的 `ema`；`wall.ts` 把繪馬放進指定欄或「繪馬掛所」欄，把留言掛到展品與繪馬上，說明卡資料加入繪馬與留言。
- 繪馬元件、紙籤、說明卡留言區、閱讀模式。
- `check.mjs` 依第 9 節加檢查。
- **驗收**：在暫存分支放測試用投稿（標「測試」）驗證後移除；`npm run build` 通過；桌機與手機 400px、淺色與深色各看一次；開一張有留言的展品說明卡、一塊繪馬；用 ← → 確認繪馬在瀏覽順序裡；沒有任何投稿時網站與現在完全一樣。

### 第 2 段：Worker、D1、API

- `worker/index.ts`、`worker/schema.sql`、`wrangler.jsonc` 依第 5、6 節。
- **驗收**：`wrangler dev` 加 `access.dev` 模擬身分，測：未登入 401、不在名單 403、`Origin` 不對 403、各種長度與 `target` 錯誤 400、撤回別人的 403、撤回已展出的 409、每日上限 429、`GET` 不含別人的 email。靜態頁面請求不進 Worker（`run_worker_first` 只有 `/api/*`）。

### 第 3 段：編寫頁

- `/edit/` 依 7.2 節。
- **驗收**：本機 `astro dev` + `wrangler dev`，用兩個模擬身分各留言、互相回覆、掛繪馬、撤回；確認「待展出」樣式、別人的未採用看不到、送出失敗保留內容；手機 400px 可完成整個流程。

### 第 4 段：收稿腳本

- 依第 8 節。
- **驗收**：對本機 D1（`--local`）跑一輪：列出、部分展出、部分不採用、相依順序保留、檔案已存在不覆寫；產生的 YAML 通過 `npm run build`。

### 第 5 段：上線（Viking）

1. 建 D1、執行 schema；設 One-time PIN 與 Access 應用、填六人 email。
2. 驗證 5.1 節的兩個［待驗證］項目。
3. `npm run deploy`（Viking 執行）。
4. 自己先用手機登入 `/edit/` 試一則留言與一塊繪馬 → `notes:pull` → 再部署 → 確認公開網站出現。
5. 通知友人。
6. 更新 README（第 6 節架構、第 7 節待辦）與 CLAUDE.md（新指令 `notes:pull`；鐵則：投稿原文照錄、Claude 不寫也不改投稿）。

---

## 11. 成本與維護

- **費用**：預期 0 元。Workers 免費方案；D1 免費額度每天讀 500 萬列、寫 10 萬列、總容量 5 GB（Cloudflare 定價頁）；靜態資源請求不計費；Access 免費方案［待驗證人數上限］。
- **要顧的東西**：一個 Worker、一個 D1 資料庫、一個 Access 應用、六人名單。
- **日常流程**：友人隨時寫 → Viking 有空時 `notes:pull` → 部署。
- **以後的旅行**：`notes` collection、Worker、編寫頁都可以沿用，只要換 D1 資料庫和名單。

## 12. 還可以再調整的預設

以下是本文件先定的做法，Viking 想改隨時說：

1. 收稿前要不要經過 Viking 逐筆確認（目前：要，3.5 節）。
2. 自己的投稿能不能在收稿前撤回（目前：可以）。
3. 長度限制（留言與繪馬 `body` 300 字、署名 20 字）［決定］。
4. 公開網站要不要顯示投稿日期（目前：說明卡裡顯示日期，牆上不顯示）。
5. 繪馬字體（目前：沿用 Noto Serif TC）。
6. 原本每天的 `slot`（心得欄位）：本規格不動它。Viking 自己的心得也可以改用繪馬寫，之後再決定要不要拿掉 `slot`。
