import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async () => {
  const days = (await getCollection('days')).map((d) => d.data.date).sort();
  const exhibits = (await getCollection('exhibits')).map((e) => e.id).sort();
  const notes = await getCollection('notes');
  const emas = notes.filter((n) => n.data.kind === 'ema').map((n) => n.id).sort();
  const comments = notes
    .filter((n) => n.data.kind === 'comment')
    .map((n) => ({ id: n.id, target: n.data.target }));
  return new Response(JSON.stringify({ days, exhibits, emas, comments }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
