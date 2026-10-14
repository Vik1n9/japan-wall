# CLAUDE.md — 日本旅行展覽牆

需求背景、設計規格與決策紀錄都在 README，動手前先讀：

@README.md

## 溝通

- 繁體中文、Markdown；先結論後分析。
- 區分事實／推論／意見；不確定就說不確定。
- 有多種做法時列出優缺點，讓 Viking 決定。

## 指令

| 指令 | 用途 |
|---|---|
| `npm run dev` | 本機預覽（http://localhost:4321），未掛上牆的展品會顯示紅色提示 |
| `npm run ingest -- <日期> [--city 城市] [--place 地點]` | 匯入 `raw/<日期>/` 的原始照片與短片 |
| `npm run ingest -- <日期> --redo <編號>` | 依展品檔的 `crop` / `blur` / `edit`（短片剪輯）重新轉檔 |
| `npm run check` | 隱私與引用檢查（`npm run build` 前會自動執行） |
| `npm run build` | 建置到 `dist/` |

專案指令：`/add-day <日期>`（新增一天）、`/review`（分享前檢查）。

## 資料在哪裡

- `src/content/site/trip.yaml`：標題、起始日（推算 DAY n）、布條、署名。
- `src/content/days/<日期>.yaml`：**怎麼排**。城市、地點、`columns`（欄寬與欄內項目：`exhibit` / `text` / `slot`）。`status: pending` 是空展區。
- `src/content/exhibits/<編號>.yaml`：**這是什麼**。類型、時刻、標題、說明、媒體路徑、尺寸、原始檔名、`draft`。
- `public/media/<日期>/`：處理後的媒體。`raw/<日期>/`：原始檔，不進 Git。
- 城市「年代」不另外存：連續同城市的日子自動併成一段。

## 鐵則

1. **不編造**：時刻只能來自 metadata；讀不到就留 `null`。說明（`note`、文字卡）只寫畫面看得到的事實。Viking 的感受只能由他寫，用 `slot`（心得欄位）提示。
2. **不覆寫人寫的內容**：改展品檔前先讀；`draft: false` 的展品，標題與說明不得更動，除非 Viking 明確要求。
3. **隱私**：`public/` 不得有帶 metadata 的檔案，也不得有 HEIC/MOV 原檔（`npm run check` 會擋）。看到路人正臉要告知 Viking，不要自行刪除。
4. **排版是策展決定**：ingest 只把新展品放進 `unsorted` 欄。可以提出排版建議，但要說明依據（拍攝時間、主題、直橫幅比例），由 Viking 確認。
5. **外觀以 `prototype/index.html` 為準**：改樣式前先比對原型；新增樣式要同時支援淺色與深色模式、手機寬度 400px。
6. **驗證**：每次修改後執行 `npm run build`；動到版面時，用瀏覽器在桌機與手機寬度各看一次，並開一次展品說明卡。
7. 不要再推薦一般部落格或攝影作品集主題（已被否決）。

## 已知限制

- 日期採日本式 30 小時制：凌晨 0:00–5:59 歸前一天（時刻 24:00–29:59），`ingest` 自動換算；深夜素材放進前一天的 `raw/` 資料夾。
- `ingest` 結束時會刪除整個 `.tmp/`，其他暫存檔不要放那裡。
- 路人臉部虛化用展品檔的 `blur`（比例座標），`--redo` 會重新套用。
- 短片剪輯用展品檔的 `edit`；防手震需要 `brew install ffmpeg-full`。運鏡速度統一到每秒 ≤15% 畫面寬（電影級），新短片也照這個標準。
- HEIC 轉檔走 macOS 內建 `sips`，在雲端測試時沒有 HEIC 樣本，第一次匯入 HEIC 時請確認結果。
- 新素材依拍攝時間編號；但對已有展品的日子追加素材時，新編號會接在後面，不會插入中間。
