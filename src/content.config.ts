import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式須為 YYYY-MM-DD（加引號）');
const clock = z.string().regex(/^\d{2}:\d{2}$/, '時刻格式須為 HH:MM（加引號）');
const fileId = ({ entry }: { entry: string }) => entry.replace(/\.ya?ml$/, '');

/** 整趟旅行的設定：只有一個檔案 src/content/site/trip.yaml */
const site = defineCollection({
  loader: glob({ pattern: 'trip.yaml', base: './src/content/site', generateId: fileId }),
  schema: z.object({
    title: z.string(),
    eyebrow: z.string().default('特展'),
    start: isoDate,                       // DAY 1 的日期，用來推算天數
    prefix: z.string().default('JP'),     // 展品編號前綴
    intro: z.string(),
    banner: z.object({
      text: z.string(),                   // 紅色直書布條的字
      photo: z.string().optional(),       // 第二幅布條的照片，路徑相對於 public/
      caption: z.string().optional(),
    }),
    // 視覺素材（裝飾用，不是展品），路徑相對於 public/
    art: z
      .object({
        titleV: z.string().optional(),    // 直書標題圖（SVG，用 mask 上色，跟著淺色／深色）
        titleH: z.string().optional(),    // 橫書標題圖
        wall: z.string().optional(),      // 牆腳石垣，左右無縫重複
        castle: z.string().optional(),    // 序幕插圖（透明背景）
        rope: z.string().optional(),      // 年代橫線換成注連繩：左右無縫重複的繩子（橫）
        shide: z.string().optional(),     // 繩下的紙垂，tile 本身含間距
        emaRoof: z.string().optional(),   // 文字卡改成繪馬：屋頂與掛繩（依卡片寬度等比縮放）
        emaBody: z.string().optional(),   // 繪馬板身（border-image 伸縮，跟著文字長度）
        eave: z.string().optional(),      // 石垣上方的瓦屋簷，左右無縫重複
      })
      .default({}),
    // 取自網路的背景圖：授權要求署名，顯示在結尾
    sources: z
      .array(z.object({ what: z.string(), author: z.string(), license: z.string(), licenseUrl: z.string(), url: z.string(), changes: z.string().optional() }))
      .default([]),
    credits: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    footnote: z.string().optional(),
  }),
});

/** 欄位裡的一個項目：展品、文字卡、心得欄位、或指定位置的繪馬 */
const columnItem = z.union([
  z.object({ exhibit: z.string() }),
  z.object({
    text: z.object({
      time: clock.nullable().optional(),
      title: z.string(),
      body: z.string(),
    }),
  }),
  z.object({ slot: z.string() }),
  z.object({ ema: z.string() }),
]);

/** 每天一個檔案：src/content/days/YYYY-MM-DD.yaml。負責「怎麼排」 */
const days = defineCollection({
  loader: glob({ pattern: '*.yaml', base: './src/content/days', generateId: fileId }),
  schema: z.object({
    date: isoDate,
    status: z.enum(['live', 'pending']).default('live'),
    city: z.string().optional(),          // 同城市的連續日子會自動併成一個「年代」
    place: z.string().optional(),
    note: z.string().optional(),          // pending 時顯示在虛線框裡
    // 當天的背景拼貼（裝飾，不是展品）。x：圖片中心在當天寬度的位置（%，可小於 0 或大於 100，出血到隔壁）；
    // y：圖片上緣在整面牆高的位置（%）；h：圖片高度佔牆高（%）；r：旋轉角度
    backdrop: z
      .array(z.object({ src: z.string(), x: z.number(), y: z.number().default(0), h: z.number().default(50), r: z.number().default(0) }))
      .default([]),
    columns: z
      .array(
        z.object({
          width: z.number().int().min(160).max(640).default(240),
          unsorted: z.boolean().optional(), // ingest 新增、尚未排版的欄
          items: z.array(columnItem),
        }),
      )
      .default([]),
  }),
});

/** 每件展品一個檔案：src/content/exhibits/JP-02-07.yaml。負責「這是什麼」 */
const exhibits = defineCollection({
  loader: glob({ pattern: '*.yaml', base: './src/content/exhibits', generateId: fileId }),
  schema: z.object({
    type: z.enum(['photo', 'video']),
    date: isoDate,
    time: clock.nullable().default(null), // 讀不到拍攝時間就是 null，不可編造
    title: z.string().default(''),
    place: z.string().default(''),
    note: z.string().default(''),         // 只寫畫面看得到的事實
    media: z.string(),                    // 相對於 public/
    poster: z.string().optional(),        // 短片封面，相對於 public/
    width: z.number().int(),
    height: z.number().int(),
    duration: z.string().optional(),      // 短片長度，例如 "0:12"
    source: z.string().nullable().default(null), // raw/ 裡的原始檔名
    clip: z.object({ start: z.number().min(0), duration: z.number().positive() }).nullable().default(null),
    crop: z.object({ top: z.number().min(0).max(1), bottom: z.number().min(0).max(1) }).nullable().default(null), // 照片上下裁切，以高度比例表示
    // 短片剪輯：防手震、片段取捨與調速、封面時間點（ingest 轉檔時套用，見 scripts/ingest.mjs）
    edit: z
      .object({
        stabilize: z.boolean().default(false),
        smoothing: z.number().int().min(1).max(100).optional(), // 防手震平滑強度，預設 24
        segments: z.array(z.object({ start: z.number().min(0), end: z.number().positive(), speed: z.number().positive().max(4).default(1) })).optional(),
        poster: z.number().min(0).optional(),
      })
      .nullable()
      .default(null),
    // 路人臉部虛化：[x, y, w, h]（轉正後整張照片的比例，0–1），ingest 轉檔時套用
    blur: z.array(z.array(z.number().min(0).max(1)).length(4)).nullable().default(null),
    draft: z.boolean().default(true),     // 標題與說明確認後改成 false
    remarks: z.string().optional(),       // 給維護者的備註，不顯示在網站上
  }),
});

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, '投稿時間須為含時區的 ISO 8601 字串（加引號）');

/** 同行友人的留言與繪馬：src/content/notes/n-YYYYMMDD-xxxx.yaml（由 notes:pull 產生，原文照錄） */
const notes = defineCollection({
  loader: glob({ pattern: '*.yaml', base: './src/content/notes', generateId: fileId }),
  schema: z
    .object({
      kind: z.enum(['comment', 'ema']),
      target: z.string(),
      replyTo: z.string().nullable().default(null),
      by: z.string().max(20, '署名最多 20 字').default(''),
      body: z.string().min(1, '內文不可為空').max(300, '內文最多 300 字'),
      posted: isoTimestamp,
    })
    .superRefine((val, ctx) => {
      if (val.kind === 'ema') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(val.target)) {
          ctx.addIssue({ code: 'custom', path: ['target'], message: '繪馬的 target 須為日期 YYYY-MM-DD' });
        }
        if (val.replyTo !== null) {
          ctx.addIssue({ code: 'custom', path: ['replyTo'], message: '繪馬不可有 replyTo' });
        }
      } else {
        if (!/^(JP-\d{2}-\d{2}|n-\d{8}-[a-z0-9]{4})$/.test(val.target)) {
          ctx.addIssue({ code: 'custom', path: ['target'], message: '留言的 target 須為展品編號（JP-）或繪馬編號（n-）' });
        }
      }
    }),
});

export const collections = { site, days, exhibits, notes };
