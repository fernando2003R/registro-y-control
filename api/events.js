export default async function handler(req, res){
  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }
  try {
    const { kv } = await import('@vercel/kv');
    const body = req.body || {};
    const student_id = String(body.student_id || '').trim();
    const type = String(body.type || '').trim();
    const ts = body.ts || new Date().toISOString();
    if (!student_id || (type !== 'entrada' && type !== 'salida')) { res.status(400).json({ ok: false }); return; }
    const key = `events:${ts.slice(0,10)}`;
    await kv.lpush(key, JSON.stringify({ student_id, type, ts }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'kv_unavailable' });
  }
}