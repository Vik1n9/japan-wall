# TODO — 工作階段交接

> 給接手的 Claude Code 工作階段看的待辦與現況。README 是給人讀的網站介紹，設計與決策在 `docs/decisions.md`，進度、交接與待辦只寫在這裡。
> 完成一項就勾選並更新日期；整段做完就刪掉，不留歷史（歷史在 git log）。
> 最後更新：2026-10-18 晚

## 現況

- 五天 66 件展品、短片、視覺素材、屋簷趣事帶、後台 2.0 都已完成。
- 線上 https://osaka2026.voriens.dev 還是 2026-10-15 的版本。D1、R2、遠端資料表已建好，剩建管理員與部署（見下方第 5、6 步）。
- 後台本機測試：`test:api` 45/45、`test:ui` 45/45 通過（後台第十輪，`07e8ed0`）。
- Git：2026-10-18 已全部 push 到 GitHub（到 `41f2829`）。之後的 commit 要 push 前先問 Viking。

## 第一次部署後台 2.0

這是 Cloudflare 帳號的一次性設定，做完之後的例行部署照 README「部署」一節。每一步都是對外操作，**先問 Viking 再做**。

- [x] **1. `wrangler login`**：2026-10-18 在 Mac mini 完成，帳號是 Viking.lu@gmail.com's Account。
  - 憑證存在本機 `~/.wrangler`。換機器或 token 過期要重登：請 Viking 在提示列打 `! npx --yes wrangler@4 login`，或由工作階段在背景跑同一指令，讓瀏覽器跳出授權頁。
- [x] **2. 建 D1 `osaka2026`**：2026-10-18 建立（APAC），`database_id` 已填進 `wrangler.jsonc` 和 `wrangler.back.jsonc`。
  - 帳號裡另有 `osaka2026-notes` 是已廢棄的收稿後台留下的空資料庫（0 張表），**不要沿用**。要不要刪由 Viking 決定。
- [x] **3. 建 R2 `osaka2026-uploads`**：2026-10-18 經 Viking 同意開通 R2 訂閱（免費額度內 $0，超額才向已存的卡計費），bucket 已建立。
- [x] **4. 建遠端資料表**：2026-10-18 `npm run db:setup:remote` 完成，5 張表。
- [ ] **5. 建第一個管理員**：`npm run admin:create -- <帳號> <顯示名稱>`。
  - 帳號名稱問 Viking。
  - 初始密碼只會印一次，**不要貼在對話裡**，寫進工作階段 scratchpad 的檔案，再告訴 Viking 檔案路徑。
- [ ] **6. 部署**：先 `npm run deploy:back`（後台 kura.osaka2026.voriens.dev），再 `npm run deploy`（前台 osaka2026.voriens.dev）。
- [ ] **7. 上線檢查**：
  - 前台：桌機與手機寬度各看一次，開一張說明卡、播一支短片。
  - 後台：登入 `/admin` 建好親友帳號；用 `/edit` 試傳一張照片、掛一塊繪馬，回前台確認看得到。
  - 最後到 `/admin` 的內容審核刪掉測試內容。

## 等 Viking 決定

- [ ] 要不要刪除舊的 D1 `osaka2026-notes`。
- [ ] 後台要不要再做幾輪優化。做法：測試 → 修 → commit 循環，只有設計決策才停下來問。

## 可選（Viking 尚未要求，提出即可，不要自行動手）

- [ ] 趣事帶 DAY 3：右側兩隻貓比左側小一點。
- [ ] 趣事帶 DAY 4：可愛少了圍兜。

## 長期待辦

- [ ] **心得欄位**：每天的 `slot` 由 Viking 自己填。填好改成 `text` 文字卡；`slot` 只在 `npm run dev` 顯示，公開版不出現。
- [ ] **向同行友人索取原始照片**（HEIC／JPEG 原檔，保留 EXIF 拍攝時間）。LINE 相簿的 23 件拿到原檔後可以補上時刻。
- [ ] **屋簷改成浮世繪**：`public/art/eave.svg` 還是手繪 SVG 暫用版，跟其他浮世繪素材風格不一。（33 張每日背景已在 `08c1199` 風格化完成。）
- [ ] **日期不明的 LINE 相簿照片**：梅田藍天大廈夜景、寶可夢中心、JUMP SHOP、螃蟹宴、燒肉、龍貓、刀具店櫥窗等，留在 `raw/` 根目錄，之後再處理。
- [ ] **第一次匯入 HEIC 時確認 `sips` 流程**：目前的原始檔都是 JPEG，HEIC 轉檔還沒實測過。
