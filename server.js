const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const { SerialPort } = require("serialport");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const SERIAL_PORT = process.env.SERIAL_PORT || "";
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || "9600", 10);
const SERIAL_MOCK = String(process.env.SERIAL_MOCK || "false").toLowerCase() === "true";
const ADMIN_CODE = process.env.ADMIN_CODE || "1234";
const SESSION_SECRET = process.env.SESSION_SECRET || "local-secret";
const CLOUD_ENDPOINT = process.env.CLOUD_ENDPOINT || ""; // e.g., https://your-vercel-domain.vercel.app/api/events

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  next();
});
const openedPorts = new Set();
const portInstances = new Map();
const sseClients = new Set();
const db = new Database(path.join(__dirname, "data.sqlite"));

db.exec(
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL, type TEXT CHECK(type IN ('entrada','salida')) NOT NULL, ts TEXT NOT NULL)"
);
db.exec(
  "CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('escolar','universitario')), name TEXT, grade TEXT, code TEXT)"
);

const insertEvent = db.prepare(
  "INSERT INTO events (student_id, type, ts) VALUES (?, ?, ?)"
);
const selectLastTypeForStudent = db.prepare(
  "SELECT type FROM events WHERE student_id = ? ORDER BY ts DESC LIMIT 1"
);
const selectEventsBetween = db.prepare(
  "SELECT id, student_id, type, ts FROM events WHERE ts BETWEEN ? AND ? ORDER BY ts DESC"
);
const selectEventsBetweenWithStudents = db.prepare(
  "SELECT e.id, e.student_id, e.type, e.ts, s.kind, s.name, s.grade, s.code FROM events e LEFT JOIN students s ON s.id = e.student_id WHERE e.ts BETWEEN ? AND ? ORDER BY e.ts DESC"
);
const upsertStudent = db.prepare(
  "INSERT INTO students (id, kind, name, grade, code) VALUES (@id, @kind, @name, @grade, @code) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, grade=excluded.grade, code=excluded.code"
);
const getStudent = db.prepare("SELECT id, kind, name, grade, code FROM students WHERE id = ?");

function nowIso() {
  return new Date().toISOString();
}

function parseLine(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const type =
    lower.includes("entrada") || lower.includes("ingreso") ? "entrada" :
    (lower.includes("salida") || lower.includes("egreso")) ? "salida" :
    null;
  const idMatch = s.match(/\d+/);
  const studentId = idMatch ? idMatch[0] : null;
  if (!studentId) return null;
  return { studentId, type };
}

function resolveType(studentId, explicitType) {
  if (explicitType) return explicitType;
  const row = selectLastTypeForStudent.get(studentId);
  if (!row) return "entrada";
  return row.type === "entrada" ? "salida" : "entrada";
}

function recordEventFromLine(line) {
  const parsed = parseLine(line);
  if (!parsed) return;
  const type = resolveType(parsed.studentId, parsed.type);
  const ts = nowIso();
  insertEvent.run(parsed.studentId, type, ts);
  if (CLOUD_ENDPOINT) {
    const payload = { student_id: parsed.studentId, type, ts };
    try { fetch(CLOUD_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {}); } catch {}
  }
  const payload = { student_id: parsed.studentId, type, ts };
  for (const res of sseClients) {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
  }
}

async function detectArduinoPort() {
  try {
    const ports = await SerialPort.list();
    const preferred = ports.find(p => {
      const m = (p.manufacturer || "").toLowerCase();
      const v = String(p.vendorId || "").toLowerCase();
      return (
        m.includes("arduino") ||
        m.includes("wch") ||
        m.includes("silicon labs") ||
        v === "2341" ||
        v === "1a86" ||
        v === "10c4"
      );
    });
    return preferred ? preferred.path : (ports[0] ? ports[0].path : "");
  } catch (e) {
    return "";
  }
}

function startSerialOnPath(serialPath) {
  const port = new SerialPort({ path: serialPath, baudRate: SERIAL_BAUD });
  console.log(`Serial escuchando en ${serialPath} @ ${SERIAL_BAUD}`);
  openedPorts.add(serialPath);
  portInstances.set(serialPath, port);
  let buffer = "";
  port.on("data", chunk => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r/g, "");
      buffer = buffer.slice(idx + 1);
      recordEventFromLine(line);
    }
  });
  port.on("error", err => {
    console.warn(`Error serial en ${serialPath}: ${err && err.message ? err.message : String(err)}`);
  });
  port.on("close", () => {
    openedPorts.delete(serialPath);
    portInstances.delete(serialPath);
  });
}

async function initSerial() {
  if (SERIAL_MOCK) {
    let nextId = 1001;
    setInterval(() => {
      const id = String(nextId + Math.floor(Math.random() * 5));
      recordEventFromLine(id);
    }, 5000);
    return;
  }
  const chosen = SERIAL_PORT.trim();
  if (chosen) {
    startSerialOnPath(chosen);
    return;
  }
  let ports = [];
  try {
    ports = await SerialPort.list();
  } catch (e) {
    ports = [];
  }
  for (const p of ports) {
    if (p.path) startSerialOnPath(p.path);
  }
}

app.get("/api/ports", async (req, res) => {
  let ports = [];
  try { ports = await SerialPort.list(); } catch (e) { ports = []; }
  res.json({
    baud: SERIAL_BAUD,
    configured: SERIAL_PORT || null,
    opened: Array.from(openedPorts.values()),
    detected: ports.map(p => ({ path: p.path, manufacturer: p.manufacturer, vendorId: p.vendorId }))
  });
});

app.post("/api/reconnect", async (req, res) => {
  for (const [path, port] of portInstances) {
    try { port.close(); } catch {}
    portInstances.delete(path);
    openedPorts.delete(path);
  }
  await initSerial();
  res.json({ ok: true, opened: Array.from(openedPorts.values()) });
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();
  sseClients.add(res);
  const keep = setInterval(() => { try { res.write(`:ping\n\n`); } catch {} }, 15000);
  req.on("close", () => { clearInterval(keep); sseClients.delete(res); });
});

function dayBounds(dateStr) {
  const d = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

app.get("/api/logs", (req, res) => {
  const q = req.query || {};
  const { start, end } = dayBounds(q.date);
  const rows = selectEventsBetweenWithStudents.all(start, end);
  res.json({ items: rows });
});

app.get("/api/stats", (req, res) => {
  const q = req.query || {};
  const { start, end } = dayBounds(q.date);
  const rows = selectEventsBetween.all(start, end);
  const byStudent = new Map();
  let entradas = 0;
  let salidas = 0;
  for (const r of rows) {
    if (r.type === "entrada") entradas++; else salidas++;
    byStudent.set(r.student_id, r);
  }
  let presentes = 0;
  for (const [, last] of byStudent) {
    if (last.type === "entrada") presentes++;
  }
  res.json({ entradas, salidas, presentes });
});

app.post("/api/reset", (req, res) => {
  db.exec("DELETE FROM events");
  res.json({ ok: true });
});

app.post("/api/students", (req, res) => {
  const b = req.body || {};
  const id = String(b.id || "").trim();
  const kind = String(b.kind || "").trim();
  const name = b.name ? String(b.name).trim() : null;
  const grade = b.grade ? String(b.grade).trim() : null;
  const code = b.code ? String(b.code).trim() : null;
  if (!id || (kind !== "escolar" && kind !== "universitario")) {
    res.status(400).json({ ok: false });
    return;
  }
  if (kind === "escolar" && (!name || !grade)) {
    res.status(400).json({ ok: false });
    return;
  }
  if (kind === "universitario" && (!code)) {
    res.status(400).json({ ok: false });
    return;
  }
  upsertStudent.run({ id, kind, name, grade, code });
  res.json({ ok: true });
});

app.get("/api/students/:id", (req, res) => {
  const id = String(req.params.id || "");
  const s = getStudent.get(id);
  res.json({ item: s || null });
});

app.get("/api/metrics/day", (req, res) => {
  const q = req.query || {};
  const { start, end } = dayBounds(q.date);
  const rows = selectEventsBetween.all(start, end);
  const entradasByHour = Array.from({ length: 24 }, () => 0);
  const salidasByHour = Array.from({ length: 24 }, () => 0);
  const perStudent = new Map();
  for (const r of rows) {
    const h = new Date(r.ts).getHours();
    if (r.type === "entrada") entradasByHour[h]++; else salidasByHour[h]++;
    const s = perStudent.get(r.student_id) || { student_id: r.student_id, entradas: 0, salidas: 0, total: 0 };
    if (r.type === "entrada") s.entradas++; else s.salidas++;
    s.total = s.entradas + s.salidas;
    perStudent.set(r.student_id, s);
  }
  const entradasTotal = entradasByHour.reduce((a,b)=>a+b,0);
  const salidasTotal = salidasByHour.reduce((a,b)=>a+b,0);
  let peakHour = 0;
  let peakValue = 0;
  for (let i=0;i<24;i++){
    const v = entradasByHour[i] + salidasByHour[i];
    if (v > peakValue){ peakValue = v; peakHour = i; }
  }
  const topStudents = Array.from(perStudent.values()).sort((a, b) => b.total - a.total).slice(0, 10);
  res.json({
    hours: { labels: Array.from({ length: 24 }, (_, i) => i), entradas: entradasByHour, salidas: salidasByHour },
    topStudents,
    indicators: {
      peakHour,
      peakValue,
      ratioEntradaSalida: salidasTotal > 0 ? entradasTotal / salidasTotal : null
    },
    lastEvents: rows.slice(0, 10)
  });
});

app.get("/api/metrics/range", (req, res) => {
  const q = req.query || {};
  const s = q.start;
  const e = q.end;
  let start;
  let end;
  if (s && e) {
    start = new Date(s).toISOString();
    const endD = new Date(e);
    endD.setHours(23, 59, 59, 999);
    end = endD.toISOString();
  } else {
    const b = dayBounds(q.date);
    start = b.start;
    end = b.end;
  }
  const rows = selectEventsBetween.all(start, end);
  const entradasByHour = Array.from({ length: 24 }, () => 0);
  const salidasByHour = Array.from({ length: 24 }, () => 0);
  const perStudent = new Map();
  for (const r of rows) {
    const h = new Date(r.ts).getHours();
    if (r.type === "entrada") entradasByHour[h]++; else salidasByHour[h]++;
    const srec = perStudent.get(r.student_id) || { student_id: r.student_id, entradas: 0, salidas: 0, total: 0 };
    if (r.type === "entrada") srec.entradas++; else srec.salidas++;
    srec.total = srec.entradas + srec.salidas;
    perStudent.set(r.student_id, srec);
  }
  const entradasTotal = entradasByHour.reduce((a,b)=>a+b,0);
  const salidasTotal = salidasByHour.reduce((a,b)=>a+b,0);
  let peakHour = 0;
  let peakValue = 0;
  for (let i=0;i<24;i++){
    const v = entradasByHour[i] + salidasByHour[i];
    if (v > peakValue){ peakValue = v; peakHour = i; }
  }
  const topStudents = Array.from(perStudent.values()).sort((a, b) => b.total - a.total).slice(0, 10);
  const cumulative = [];
  let ce = 0;
  let cs = 0;
  let ct = 0;
  for (const r of rows.slice().reverse()) {
    if (r.type === "entrada") ce++; else cs++;
    ct = ce + cs;
    cumulative.push({ ts: r.ts, entradas: ce, salidas: cs, total: ct });
  }
  res.json({
    range: { start, end },
    hours: { labels: Array.from({ length: 24 }, (_, i) => i), entradas: entradasByHour, salidas: salidasByHour },
    topStudents,
    indicators: {
      peakHour,
      peakValue,
      ratioEntradaSalida: salidasTotal > 0 ? entradasTotal / salidasTotal : null
    },
    cumulative,
    lastEvents: rows.slice(0, 10)
  });
});

function parseCookies(req) {
  const header = req.headers["cookie"] || "";
  const out = {};
  header.split(";").forEach(part => {
    const [k, v] = part.split("=").map(s => s && s.trim());
    if (k && v) out[k] = v;
  });
  return out;
}

function tokenForCode(code) {
  return crypto.createHash("sha256").update(String(code) + ":" + SESSION_SECRET).digest("hex");
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  return cookies.session === tokenForCode(ADMIN_CODE);
}

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.redirect("/login.html");
}

app.post("/api/login", (req, res) => {
  const code = String((req.body && req.body.code) || "");
  if (code === ADMIN_CODE) {
    res.setHeader("Set-Cookie", `session=${tokenForCode(code)}; Path=/; HttpOnly; SameSite=Lax`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", `session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

app.get('/index.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/stats.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});

app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  initSerial();
  console.log(`Servidor listo en http://localhost:${PORT}`);
});