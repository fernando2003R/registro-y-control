const { dayBounds } = require('./_utils');

exports.default = async (req, res) => {
  try {
    const { kv } = await import('@vercel/kv');
    const q = req.query || {};
    const { date } = dayBounds(q.date);
    const key = `events:${date}`;
    const raw = await kv.lrange(key, 0, -1);
    const items = (raw || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean).reverse();
    res.json({ items });
  } catch (e) {
    res.status(500).json({ items: [] });
  }
};