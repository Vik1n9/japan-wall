import { getCollection, getEntry, type CollectionEntry } from 'astro:content';

export type Trip = CollectionEntry<'site'>['data'];
export type DayData = CollectionEntry<'days'>['data'];
export type Exhibit = CollectionEntry<'exhibits'>['data'] & { id: string };

export type Item =
  | { kind: 'exhibit'; exhibit: Exhibit; index: number }
  | { kind: 'text'; time: string | null; title: string; body: string }
  | { kind: 'slot'; text: string };

export interface Column { width: number; unsorted: boolean; items: Item[] }
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
  counts: { photo: number; video: number };
}
export interface Era { key: string; label: string; num: string; range: string; pending: boolean; days: Day[] }

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const label = (iso: string) => `${+iso.slice(5, 7)}.${iso.slice(8, 10)}`;

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
  for (const e of await getCollection('exhibits')) exhibitMap.set(e.id, { ...e.data, id: e.id });

  const dayEntries = (await getCollection('days')).sort((a, b) => a.data.date.localeCompare(b.data.date));
  const media: Exhibit[] = [];
  const placed = new Set<string>();

  const days: Day[] = dayEntries.map(({ data: d }) => {
    const n = Math.round((utc(d.date).getTime() - utc(trip.start).getTime()) / 86_400_000) + 1;
    const counts = { photo: 0, video: 0 };
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
        if ('text' in it) return { kind: 'text', time: it.text.time ?? null, ...it.text };
        return { kind: 'slot', text: it.slot };
      }),
    }));
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
  const videos = media.filter((m) => m.type === 'video').length;
  return { trip, eras, media, unplaced, stats: { live, total: media.length, photos: media.length - videos, videos } };
}
