// 軟刪除帳號（users.deleted_at IS NOT NULL）的內容一律視為不存在。
// 公開牆、編輯清單、投稿目標檢查與媒體都引用這裡的 SQL 片段，只有一份定義，
// 避免每個地方各寫一套、日後不同步（例：忘記把某處的 EXISTS 也加上 deleted_at 條件）。
//
// 注意：別人的回覆若掛在被軟刪除帳號的「留言」底下，target 仍是原本的展品／繪馬等，
// 因此照舊公開——牆面會把「父留言不見的回覆」當頂層顯示（src/scripts/wall.ts renderComments）。

/** alias 的 `author` 欄位所指帳號不是軟刪除中的帳號。子查詢固定用 alias `du`，可直接接在 WHERE 後。 */
export function authorVisible(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM users du WHERE du.username = ${alias}.author AND du.deleted_at IS NOT NULL)`;
}

/** 一張照片／影片（alias）看得見：還在線上、作者沒被軟刪除。 */
export function photoVisible(alias: string): string {
  return `${alias}.status = 'live' AND ${authorVisible(alias)}`;
}

/** 一則投稿（alias）看得見：還在線上、作者沒被軟刪除，而且目標（繪馬或照片）本身也看得見。
 *  展品（target 非 n-／p- 開頭）不受軟刪除影響；
 *  別人留在被隱藏照片／繪馬上的留言會因目標不公開而跟著不公開。 */
export function postVisible(alias: string): string {
  return `${alias}.status = 'live'
    AND ${authorVisible(alias)}
    AND (${alias}.kind = 'ema'
         OR (${alias}.target NOT LIKE 'n-%' AND ${alias}.target NOT LIKE 'p-%')
         OR EXISTS (SELECT 1 FROM posts e JOIN users eu ON eu.username = e.author
                    WHERE e.id = ${alias}.target AND e.kind = 'ema' AND e.status = 'live' AND eu.deleted_at IS NULL)
         OR EXISTS (SELECT 1 FROM photos ph JOIN users pu ON pu.username = ph.author
                    WHERE ph.id = ${alias}.target AND ph.status = 'live' AND pu.deleted_at IS NULL))`;
}

/** 上傳媒體（R2 key 裡的 photos.id）是否看得見：該照片的作者不是軟刪除中的帳號。
 *  軟刪除期間 R2 物件不動，所以媒體端點要自己查資料庫才擋得住。 */
export async function mediaOwnerVisible(db: D1Database, photoId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 FROM photos ph JOIN users u ON u.username = ph.author WHERE ph.id = ?1 AND u.deleted_at IS NULL`)
    .bind(photoId)
    .first();
  return !!row;
}
