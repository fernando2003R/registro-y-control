import { dayBounds } from './_utils.js';

export default async function handler(req, res){
  try {
    const { kv } = await import('@vercel/kv');
    const q = req.query || {};
    const { date } = dayBounds(q.date);
    const key = `events:${date}`;
    const raw = await kv.lrange(key, 0, -1);
    const rows = (raw || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    let entradas = 0, salidas = 0;
    const byStudent = new Map();
    for (const r of rows) {
      if (r.type === 'entrada') entradas++; else salidas++;
      byStudent.set(r.student_id, r);
    }
    let presentes = 0;
    for (const [, last] of byStudent) { if (last.type === 'entrada') presentes++; }
    res.json({ entradas, salidas, presentes });
  } catch (e) {
    res.status(500).json({ entradas: 0, salidas: 0, presentes: 0 });
  }
}