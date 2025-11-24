export default async function handler(req, res){
  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }
  const body = req.body || {};
  const student_id = String(body.student_id || '').trim();
  const type = String(body.type || '').trim();
  const ts = body.ts || new Date().toISOString();
  if (!student_id || (type !== 'entrada' && type !== 'salida')) { res.status(400).json({ ok: false }); return; }

  // Primero intentamos KV
  try {
    const { kv } = await import('@vercel/kv');
    const key = `events:${ts.slice(0,10)}`;
    await kv.lpush(key, JSON.stringify({ student_id, type, ts }));
    res.json({ ok: true, backend: 'kv' });
    return;
  } catch {}

  // Fallback: Vercel Blob (requiere BLOB_READ_WRITE_TOKEN)
  try {
    const { put, list } = await import('@vercel/blob');
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) throw new Error('blob_token_missing');
    const dayKey = `events/${ts.slice(0,10)}.json`;
    let items = [];
    try {
      const l = await list({ prefix: dayKey, token });
      if (l.blobs && l.blobs[0] && l.blobs[0].downloadUrl) {
        const r = await fetch(l.blobs[0].downloadUrl);
        const txt = await r.text();
        items = JSON.parse(txt || '[]');
      }
    } catch {}
    items.push({ student_id, type, ts });
    await put(dayKey, JSON.stringify(items), { access: 'private', token, contentType: 'application/json' });
    res.json({ ok: true, backend: 'blob' });
    return;
  } catch (e) {
    res.status(500).json({ ok: false, error: 'storage_unavailable' });
  }
}