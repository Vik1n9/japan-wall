# TODO — 工作階段交接

> 給接手的 Claude Code 工作階段看的待辦與現況。README 是給人讀的網站介紹，設計與決策在 `docs/decisions.md`，進度、交接與待辦只寫在這裡。
> 完成一項就勾選並更新日期；整段做完就刪掉，不留歷史（歷史在 git log）。
> 最後更新：2026-10-18 晚

## 現況

- 五天 66 件展品、短片、視覺素材、屋簷趣事帶、後台 2.0 都已完成。
- 2026-10-18 前台 https://osaka2026.voriens.dev 與後台 https://kura.osaka2026.voriens.dev 都已部署最新版（含照片改版），Viking 已實測登入、上傳、繪馬、照片留言。改版前上傳的 6 張照片沒有拍攝時刻、排在當天最後，Viking 決定不重傳。之後部署前先問 Viking。
- 後台本機測試：`test:api` 58/58、`test:ui` 56/56 通過（影片上傳）。
- Git：2026-10-18 已全部 push 到 GitHub。之後的 commit 要 push 前先問 Viking。

## 影片上傳與恢復聲音（本機完成，尚未上線）

- [ ] **部署**（順序不能換，每一步先問 Viking）：
  1. 正式資料庫加欄位：`npx --yes wrangler@4 d1 execute osaka2026 -c wrangler.back.jsonc --remote --file=worker/migrations/002-photos-video.sql`
  2. `npm run deploy:back`，再 `npm run deploy`
  3. 上線檢查：用手機實際傳一支 iPhone 直拍影片，確認自動選對日期、牆上位置正確、說明卡有聲音；再到 `/admin` 刪掉。
- [ ] 17 支展品短片已用 `--redo` 重新轉檔、保留聲音；上線前請 Viking 聽幾支確認音量與放慢段落的聲音可以接受。
- [ ] 後台優化交給 opencode（qwen3.8-max，worktree `../japan-wall-opencode`、分支 `opencode/backend-opt`），審查通過後再合併進 main。

## 等 Viking 決定

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
