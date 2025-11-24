import { dayBounds } from './_utils.js';

export default async function handler(req, res){
  const q = req.query || {};
  const { date } = dayBounds(q.date);
  const key = `events:${date}`;

  // Primero KV
  try {
    const { kv } = await import('@vercel/kv');
    const raw = await kv.lrange(key, 0, -1);
    const items = (raw || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean).reverse();
    res.json({ items, backend: 'kv' });
    return;
  } catch {}

  // Fallback Blob
  try {
    const { list } = await import('@vercel/blob');
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    const dayKey = `events/${date}.json`;
    const l = await list({ prefix: dayKey, token });
    if (l.blobs && l.blobs[0] && l.blobs[0].downloadUrl) {
      const r = await fetch(l.blobs[0].downloadUrl);
      const txt = await r.text();
      const arr = JSON.parse(txt || '[]');
      res.json({ items: arr.slice().reverse(), backend: 'blob' });
    } else {
      res.json({ items: [], backend: 'blob' });
    }
  } catch {
    res.status(500).json({ items: [] });
  }
}