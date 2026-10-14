import { getCollection, getEntry, type CollectionEntry } from 'astro:content';

export type Trip = CollectionEntry<'site'>['data'];
export type DayData = CollectionEntry<'days'>['data'];
export type NoteData = CollectionEntry<'notes'>['data'];

export interface Comment {
  id: string;
  target: string;
  replyTo: string | null;
  by: string;
  body: string;
  posted: string;
}

export type Exhibit = CollectionEntry<'exhibits'>['data'] & {
  id: string;
  comments: Comment[];
};

export interface Ema {
  id: string;
  type: 'ema';
  date: string;
  place: string;
  by: string;
  body: string;
  posted: string;
  tilt: number;
  comments: Comment[];
}

export type WallEntry = Exhibit | Ema;

export type Item =
  | { kind: 'exhibit'; exhibit: Exhibit; index: number }
  | { kind: 'ema'; ema: Ema; index: number }
  | { kind: 'text'; time: string | null; title: string; body: string }
  | { kind: 'slot'; text: string };

export interface Column {
  width: number;
  unsorted: boolean;
  rack?: boolean;
  items: Item[];
}
export interface Day {
  date: string;
  n: number;
  label: string;   // 10.06
  weekday: string; // 二
  status: 'live' | 'pending';
  city?: string;
  place?: string;
  note?: string;
  backdrop: { src: string; x: number; y: number; h: number; r: number }[];
  columns: Column[];
  counts: { photo: number; video: number; ema: number };
}
export interface Era { key: string; label: string; num: string; range: string; pending: boolean; days: Day[] }

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const label = (iso: string) => `${+iso.slice(5, 7)}.${iso.slice(8, 10)}`;

/** 依繪馬編號計算固定的微幅傾斜角度（-3° ～ +3°） */
export function emaTilt(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const raw = (((h >>> 0) % 601) - 300) / 100;
  // 避免剛好 0° 太呆板，小於 0.35° 時推到 ±0.6°
  if (Math.abs(raw) < 0.35) return raw < 0 ? -0.6 : 0.6;
  return raw;
}

/** 把 public/ 下的相對路徑加上 base（部署在子路徑時需要） */
export function asset(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  return base + path.replace(/^\/+/, '');
}

export async function loadWall() {
  const tripEntry = await getEntry('site', 'trip');
  if (!tripEntry) throw new Error('找不到 src/content/site/trip.yaml');
  const trip = tripEntry.data;

  const exhibitMap = new Map<string, Exhibit>();
  for (const e of await getCollection('exhibits')) {
    exhibitMap.set(e.id, { ...e.data, id: e.id, comments: [] });
  }

  const dayEntries = (await getCollection('days')).sort((a, b) => a.data.date.localeCompare(b.data.date));
  const dayPlaceMap = new Map<string, string>();
  for (const d of dayEntries) {
    dayPlaceMap.set(d.data.date, [d.data.city, d.data.place].filter(Boolean).join(' · '));
  }

  const noteEntries = (await getCollection('notes')).sort(
    (a, b) => a.data.posted.localeCompare(b.data.posted) || a.id.localeCompare(b.id),
  );
  const emaMap = new Map<string, Ema>();
  const commentMap = new Map<string, Comment>();

  for (const n of noteEntries) {
    if (n.data.kind === 'ema') {
      if (!dayPlaceMap.has(n.data.target)) {
        throw new Error(`notes/${n.id}.yaml：繪馬 target 日期 ${n.data.target} 不存在於 days/`);
      }
      emaMap.set(n.id, {
        id: n.id,
        type: 'ema',
        date: n.data.target,
        place: dayPlaceMap.get(n.data.target) || '',
        by: n.data.by,
        body: n.data.body,
        posted: n.data.posted,
        tilt: emaTilt(n.id),
        comments: [],
      });
    } else {
      commentMap.set(n.id, {
        id: n.id,
        target: n.data.target,
        replyTo: n.data.replyTo ?? null,
        by: n.data.by,
        body: n.data.body,
        posted: n.data.posted,
      });
    }
  }

  for (const c of commentMap.values()) {
    const targetObj = exhibitMap.get(c.target) ?? emaMap.get(c.target);
    if (!targetObj) {
      throw new Error(`notes/${c.id}.yaml：留言 target ${c.target} 不存在`);
    }
    if (c.replyTo) {
      const parent = commentMap.get(c.replyTo);
      if (!parent || parent.target !== c.target) {
        throw new Error(`notes/${c.id}.yaml：replyTo ${c.replyTo} 不存在或不在同一 target 底下`);
      }
    }
    targetObj.comments.push(c);
  }

  const media: WallEntry[] = [];
  const placed = new Set<string>();
  const placedEmas = new Set<string>();

  const days: Day[] = dayEntries.map(({ data: d }) => {
    const n = Math.round((utc(d.date).getTime() - utc(trip.start).getTime()) / 86_400_000) + 1;
    const counts = { photo: 0, video: 0, ema: 0 };
    const columns: Column[] = d.columns.map((c) => ({
      width: c.width,
      unsorted: !!c.unsorted,
      items: c.items.map((it): Item => {
        if ('exhibit' in it) {
          const ex = exhibitMap.get(it.exhibit);
          if (!ex) throw new Error(`${d.date}.yaml 引用了不存在的展品 ${it.exhibit}`);
          if (placed.has(ex.id)) throw new Error(`展品 ${ex.id} 被掛了兩次`);
          placed.add(ex.id);
          counts[ex.type]++;
          return { kind: 'exhibit', exhibit: ex, index: media.push(ex) - 1 };
        }
        if ('ema' in it) {
          const em = emaMap.get(it.ema);
          if (!em) throw new Error(`${d.date}.yaml 引用了不存在的繪馬 ${it.ema}`);
          if (em.date !== d.date) throw new Error(`${d.date}.yaml 引用了屬於 ${em.date} 的繪馬 ${it.ema}`);
          if (placedEmas.has(em.id)) throw new Error(`繪馬 ${em.id} 被掛了兩次`);
          placedEmas.add(em.id);
          counts.ema++;
          return { kind: 'ema', ema: em, index: media.push(em) - 1 };
        }
        if ('text' in it) return { kind: 'text', time: it.text.time ?? null, ...it.text };
        return { kind: 'slot', text: it.slot };
      }),
    }));

    // 沒有在 columns 指定位置的當日繪馬，自動依投稿時間掛在當天最後一欄「繪馬掛所」
    const autoEmas = [...emaMap.values()].filter((em) => em.date === d.date && !placedEmas.has(em.id));
    if (autoEmas.length > 0) {
      columns.push({
        width: 240,
        unsorted: false,
        rack: true,
        items: autoEmas.map((em): Item => {
          placedEmas.add(em.id);
          counts.ema++;
          return { kind: 'ema', ema: em, index: media.push(em) - 1 };
        }),
      });
    }

    return {
      date: d.date, n, label: label(d.date), weekday: WEEKDAY[utc(d.date).getUTCDay()],
      status: d.status, city: d.city, place: d.place, note: d.note, backdrop: d.backdrop, columns, counts,
    };
  });

  // 連續且同城市的日子併成一個「年代」；連續的 pending 日子也併在一起
  const eras: Era[] = [];
  for (const day of days) {
    const key = day.status === 'pending' ? '__pending' : day.city ?? '未命名';
    const last = eras.at(-1);
    if (last && last.key === key) last.days.push(day);
    else eras.push({ key, label: key === '__pending' ? '待補' : key, num: day.label, range: '', pending: key === '__pending', days: [day] });
  }
  for (const era of eras) {
    const first = era.days[0], last = era.days.at(-1)!;
    const dates = first === last ? first.label : `${first.label} — ${last.label}`;
    era.range = era.pending ? dates : [dates, first.place].filter(Boolean).join(' · ');
  }

  const unplaced = [...exhibitMap.keys()].filter((id) => !placed.has(id));
  const live = days.filter((d) => d.status === 'live').length;
  const placedExhibits = media.filter((m): m is Exhibit => m.type !== 'ema');
  const videos = placedExhibits.filter((m) => m.type === 'video').length;
  return {
    trip,
    eras,
    media,
    unplaced,
    stats: { live, total: placedExhibits.length, photos: placedExhibits.length - videos, videos },
  };
}
