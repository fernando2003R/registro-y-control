import { dayBounds } from './_utils.js';

export default async function handler(req, res){
  const q = req.query || {};
  const { date } = dayBounds(q.date);
  const key = `events:${date}`;

  let rows = [];
  // KV primero
  try {
    const { kv } = await import('@vercel/kv');
    const raw = await kv.lrange(key, 0, -1);
    rows = (raw || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  } catch {
    // Fallback Blob
    try {
      const { list } = await import('@vercel/blob');
      const token = process.env.BLOB_READ_WRITE_TOKEN;
      const dayKey = `events/${date}.json`;
      const l = await list({ prefix: dayKey, token });
      if (l.blobs && l.blobs[0] && l.blobs[0].downloadUrl) {
        const r = await fetch(l.blobs[0].downloadUrl);
        const txt = await r.text();
        rows = JSON.parse(txt || '[]');
      }
    } catch {}
  }

  try {
    let entradas = 0, salidas = 0;
    const byStudent = new Map();
    for (const r of rows) {
      if (r.type === 'entrada') entradas++; else salidas++;
      byStudent.set(r.student_id, r);
    }
    let presentes = 0;
    for (const [, last] of byStudent) { if (last.type === 'entrada') presentes++; }
    res.json({ entradas, salidas, presentes });
  } catch {
    res.status(500).json({ entradas: 0, salidas: 0, presentes: 0 });
  }
}