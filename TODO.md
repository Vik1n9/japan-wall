# TODO — 工作階段交接

> 給接手的 Claude Code 工作階段看的待辦與現況。README 是給人讀的網站介紹，設計與決策在 `docs/decisions.md`，進度、交接與待辦只寫在這裡。
> 完成一項就勾選並更新日期；整段做完就刪掉，不留歷史（歷史在 git log）。
> 最後更新：2026-10-18 晚

## 現況

- 五天 66 件展品、短片、視覺素材、屋簷趣事帶、後台 2.0 都已完成。
- 2026-10-18 前台 https://osaka2026.voriens.dev 與後台 https://kura.osaka2026.voriens.dev 都已部署最新版。
- 後台本機測試：`test:api` 45/45、`test:ui` 45/45 通過（後台第十輪，`07e8ed0`）。
- Git：2026-10-18 已全部 push 到 GitHub。之後的 commit 要 push 前先問 Viking。

## 後台 2.0 上線後，Viking 要做的

2026-10-18 已完成 Cloudflare 設定（D1 `osaka2026`、R2 `osaka2026-uploads`、遠端 5 張表、管理員 `viking`）並部署兩個 Worker。之後的例行部署照 README「部署」一節，部署前先問 Viking。

已驗證：前台桌機 1440px 與手機 400px 無橫向溢出，66 件展品、趣事帶都在，說明卡與短片正常；前台 `/edit`、`/admin`、`/api/auth/*` 都是 404，前台 JS 沒有後台痕跡；後台 `/admin` 登入頁正常。

正式密碼工作階段不代為登入，以下由 Viking 自己做：

- [ ] 用 `~/Documents/kura-admin-viking.txt` 的初始密碼登入 https://kura.osaka2026.voriens.dev/admin，改密碼，**改完刪掉這個檔**。
- [ ] 在 `/admin` 建親友帳號。
- [ ] 用 `/edit` 試傳一張照片、掛一塊繪馬，回前台確認看得到；再到 `/admin` 的內容審核刪掉測試內容。
- 忘記密碼：`npm run admin:create -- viking Viking` 重設。新密碼只印一次，**不要貼在對話裡**，寫進檔案再告訴 Viking 路徑。

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
