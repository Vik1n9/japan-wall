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
    credits: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    footnote: z.string().optional(),
  }),
});

/** 欄位裡的一個項目：展品、文字卡、或心得欄位 */
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
    draft: z.boolean().default(true),     // 標題與說明確認後改成 false
    remarks: z.string().optional(),       // 給維護者的備註，不顯示在網站上
  }),
});

export const collections = { site, days, exhibits };
