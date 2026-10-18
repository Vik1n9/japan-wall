# TODO — 工作階段交接

> 給接手的 Claude Code 工作階段看的待辦與現況。README 是給人讀的設計與決策紀錄，進度與交接寫在這裡。
> 完成一項就勾選並更新日期；整段做完就刪掉，不留歷史（歷史在 git log）。
> 最後更新：2026-10-18 晚

## 現況

- 五天 66 件展品、短片、視覺素材、屋簷趣事帶、後台 2.0 都已完成。
- 線上 https://osaka2026.voriens.dev 還是 2026-10-15 的版本。前台 Worker 綁定了後台的 D1／R2，所以 **D1、R2 建好之前，連前台（含趣事帶）都部署不上去**。
- 後台本機測試：`test:api` 45/45、`test:ui` 45/45 通過（後台第十輪，`07e8ed0`）。
- Git：`main` 領先 `origin/main`，從 `4ce95d5`（後台第一輪）之後的 commit 都還沒 push。

## 部署後台 2.0（照 README §9 的步驟）

每一步都是對外操作，**先問 Viking 再做**。

- [x] **1. `wrangler login`**：2026-10-18 在 Mac mini 完成，帳號是 Viking.lu@gmail.com's Account。
  - 憑證存在本機 `~/.wrangler`。換機器或 token 過期要重登：請 Viking 在提示列打 `! npx --yes wrangler@4 login`，或由工作階段在背景跑同一指令，讓瀏覽器跳出授權頁。
- [ ] **2. 建 D1 `osaka2026`**：`npx --yes wrangler@4 d1 create osaka2026`。
  - 把印出的 `database_id` 填進 `wrangler.jsonc` 和 `wrangler.back.jsonc`，兩處目前都是 `00000000-…` 的佔位值。
  - 帳號裡現有的 `osaka2026-notes` 是已廢棄的收稿後台留下的空資料庫（0 張表），**不要沿用**。要不要刪由 Viking 決定。
- [ ] **3. 建 R2 `osaka2026-uploads`**：帳號**尚未開通 R2**。
  - `r2 bucket list` 會回 `Please enable R2 through the Cloudflare Dashboard. [code: 10042]`。
  - Viking 要自己到 Dashboard → R2 啟用（可能要填付款方式、接受條款），工作階段不能代做。開通後執行 `npx --yes wrangler@4 r2 bucket create osaka2026-uploads`。
- [ ] **4. 建遠端資料表**：`npm run db:setup:remote`。
- [ ] **5. 建第一個管理員**：`npm run admin:create -- <帳號> <顯示名稱>`。
  - 帳號名稱問 Viking。
  - 初始密碼只會印一次，**不要貼在對話裡**，寫進工作階段 scratchpad 的檔案，再告訴 Viking 檔案路徑。
- [ ] **6. 部署**：先 `npm run deploy:back`（後台），再 `npm run deploy`（前台）。
- [ ] **7. 上線檢查**：照 README §9 第 7 點，桌機、手機、說明卡、短片、後台上傳與繪馬都試一次，最後刪掉測試內容。

## 等 Viking 決定

- [ ] 要不要 push 目前的 commit。
- [ ] 要不要刪除舊的 D1 `osaka2026-notes`。
- [ ] 後台要不要再做幾輪優化。做法：測試 → 修 → commit 循環，只有設計決策才停下來問。

## 可選（Viking 尚未要求，提出即可，不要自行動手）

- [ ] 趣事帶 DAY 3：右側兩隻貓比左側小一點。
- [ ] 趣事帶 DAY 4：可愛少了圍兜。

## 長期待辦

見 README §7：向友人索取原始照片、Mac mini 後製 33 張背景拼貼與屋簷、心得欄位由 Viking 自己填。
