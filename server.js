const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const { SerialPort, ReadlineParser } = require("serialport");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

const PORT = parseInt(process.env.PORT || "3000", 10);
const SERIAL_PORT = process.env.SERIAL_PORT || "";
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD || "9600", 10);
const SERIAL_MOCK = String(process.env.SERIAL_MOCK || "false").toLowerCase() === "true";
const ADMIN_CODE = process.env.ADMIN_CODE || "1234";
const SESSION_SECRET = process.env.SESSION_SECRET || "local-secret";
const CLOUD_ENDPOINT = process.env.CLOUD_ENDPOINT || ""; // e.g., https://your-vercel-domain.vercel.app/api/events
const TYPE_STRATEGY = (process.env.TYPE_STRATEGY || "toggle").toLowerCase();
const STRICT_IDS = String(process.env.STRICT_IDS || "false").toLowerCase() === "true";
const SCAN_WINDOW_MS = parseInt(process.env.SCAN_WINDOW_MS || "3000", 10);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "0", 10);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "";
const EMAIL_WEBHOOK_URL = process.env.EMAIL_WEBHOOK_URL || "";
const EMAIL_WEBHOOK_PROVIDER = (process.env.EMAIL_WEBHOOK_PROVIDER || "").toLowerCase();
let mailer = null;
try {
  if (SMTP_HOST && SMTP_PORT && SMTP_FROM) {
    mailer = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, auth: (SMTP_USER && SMTP_PASS) ? { user: SMTP_USER, pass: SMTP_PASS } : undefined });
  }
} catch {}
try { console.log(mailer ? "Correo habilitado" : "Correo deshabilitado"); } catch {}

async function trySendEmail(to, subject, text){
  if (mailer) {
    try {
      await mailer.sendMail({ from: SMTP_FROM, to, subject, text });
      try { console.log(`Correo enviado a ${to}`); } catch {}
      return true;
    } catch (e) {
      try { console.warn(`Error correo a ${to}: ${e && e.message ? e.message : String(e)}`); } catch {}
    }
  }
  if (EMAIL_WEBHOOK_URL) {
    try {
      const body = EMAIL_WEBHOOK_PROVIDER === 'ifttt' ? { value1: to, value2: subject, value3: text } : { to, subject, text };
      await fetch(EMAIL_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      try { console.log(`Webhook email disparado`); } catch {}
      return true;
    } catch (e) {
      try { console.warn(`Error webhook email: ${e && e.message ? e.message : String(e)}`); } catch {}
    }
  }
  return false;
}

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
const rawLog = [];
const db = new Database(path.join(__dirname, "data.sqlite"));

db.exec(
  "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL, type TEXT CHECK(type IN ('entrada','salida')) NOT NULL, ts TEXT NOT NULL)"
);
db.exec(
  "CREATE TABLE IF NOT EXISTS students (id TEXT PRIMARY KEY, kind TEXT CHECK(kind IN ('escolar','universitario')), name TEXT, grade TEXT, code TEXT)"
);
db.exec(
  "CREATE TABLE IF NOT EXISTS parents (id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL, name TEXT, tg_chat_id TEXT, phone TEXT, email TEXT, UNIQUE(student_id))"
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
const getStudentByCode = db.prepare("SELECT id, kind, name, grade, code FROM students WHERE code = ?");
const getStudentByName = db.prepare("SELECT id, kind, name, grade, code FROM students WHERE lower(name) = lower(?)");
const upsertParent = db.prepare(
  "INSERT INTO parents (student_id, name, tg_chat_id, phone, email) VALUES (?, ?, ?, ?, ?) ON CONFLICT(student_id) DO UPDATE SET name=excluded.name, tg_chat_id=excluded.tg_chat_id, phone=excluded.phone, email=excluded.email"
);
const getParentByStudent = db.prepare("SELECT id, student_id, name, tg_chat_id, phone, email FROM parents WHERE student_id = ?");
const selectEventsForStudentBetween = db.prepare(
  "SELECT id, student_id, type, ts FROM events WHERE student_id = ? AND ts BETWEEN ? AND ? ORDER BY ts DESC"
);

function nowIso() {
  return new Date().toISOString();
}

function parseLine(raw) {
  const s = String(raw).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  let studentId = null;
  let type = null;

  if (lower.includes("movimiento")) {
    const m = s.match(/movimiento\s*:\s*(\d+)\s*:[^:]*:[^:]*:(ingreso|salida)\s*:\s*(dentro|fuera)/i);
    if (m) {
      studentId = m[1];
      type = m[2].toLowerCase() === "ingreso" ? "entrada" : "salida";
      return { studentId, type };
    }
    const m2 = s.match(/movimiento\s*:\s*(\d+)\s*:[^:]*:(ingreso|salida)/i);
    if (m2) {
      studentId = m2[1];
      type = m2[2].toLowerCase() === "ingreso" ? "entrada" : "salida";
      return { studentId, type };
    }
    return null;
  }
  if (lower.includes("estado actual") || lower.includes("sistema_control_activo") || lower.startsWith("estudiante:")) {
    return null;
  }
  return null;
}

function resolveType(studentId, explicitType) {
  if (TYPE_STRATEGY === "explicit" && explicitType) return explicitType;
  const row = selectLastTypeForStudent.get(studentId);
  if (!row) return "entrada";
  return row.type === "entrada" ? "salida" : "entrada";
}

function recordEventFromLine(line) {
  const lower = String(line).toLowerCase();
  if (lower.includes("estado actual") || lower.includes("sistema_control_activo")) return;

  // Captura movimiento para usarlo cuando llegue ACCESO_PERMITIDO
  const mov = String(line).match(/movimiento\s*:\s*(\d+)\s*:[^:]*:[^:]*:(ingreso|salida)(?::(dentro|fuera))?/i);
  if (mov) {
    const now = Date.now();
    const studentId = mov[1];
    const typeExp = mov[2].toLowerCase() === "ingreso" ? "entrada" : "salida";
    recordEventFromLine.lastMove = { id: studentId, type: typeExp, at: now, committed: false };
    const exists = getStudent.get(studentId) || getStudentByCode.get(studentId);
    if (STRICT_IDS && !exists) return;
    if (!recordEventFromLine.window) recordEventFromLine.window = { at: 0, id: null };
    if (now - recordEventFromLine.window.at < SCAN_WINDOW_MS) {
      if (studentId !== recordEventFromLine.window.id) return;
      recordEventFromLine.window.at = now;
    } else {
      recordEventFromLine.window.at = now;
      recordEventFromLine.window.id = studentId;
    }
    if (!recordEventFromLine.recent) recordEventFromLine.recent = new Map();
    const lastTs = recordEventFromLine.recent.get(studentId) || 0;
    if (now - lastTs < 2000) return;
    recordEventFromLine.recent.set(studentId, now);
    const type = resolveType(studentId, typeExp);
    const ts = nowIso();
    insertEvent.run(studentId, type, ts);
    recordEventFromLine.lastMove.committed = true;
    recordEventFromLine.window = { at: 0, id: null };
    try {
      const p = getParentByStudent.get(studentId);
      if (p && p.email) {
        const s = getStudent.get(studentId);
        const label = s ? (s.kind === "escolar" && s.name && s.grade ? `${s.name} (${s.grade})` : (s.kind === "universitario" && s.code ? s.code : s.id)) : studentId;
        const subject = `Registro ${type}`;
        const text = `Registro de asistencia\nAlumno: ${label}\nEvento: ${type}\nHora: ${new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}`;
        trySendEmail(p.email, subject, text);
      }
    } catch {}
    if (CLOUD_ENDPOINT) {
      const payload = { student_id: studentId, type, ts };
      try { fetch(CLOUD_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {}); } catch {}
    }
    const payload = { student_id: studentId, type, ts };
    for (const res of sseClients) { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} }
    return;
  }

  // Confirma acceso y registra usando el último movimiento cercano
  const acc = lower.match(/acceso_permitido\s*[:\-]?\s*(ingreso|salida)/);
  if (acc) {
    const now = Date.now();
    const last = recordEventFromLine.lastMove;
    if (!last || (now - last.at) > 3000) return;
    if (last.committed) return;
    const studentId = last.id;
    const typeExp = acc[1] === "ingreso" ? "entrada" : "salida";
    const exists = getStudent.get(studentId) || getStudentByCode.get(studentId);
    if (STRICT_IDS && !exists) return;
    if (!recordEventFromLine.window) recordEventFromLine.window = { at: 0, id: null };
    if (now - recordEventFromLine.window.at < SCAN_WINDOW_MS) {
      if (studentId !== recordEventFromLine.window.id) return;
      recordEventFromLine.window.at = now;
    } else {
      recordEventFromLine.window.at = now;
      recordEventFromLine.window.id = studentId;
    }
    if (!recordEventFromLine.recent) recordEventFromLine.recent = new Map();
    const lastTs = recordEventFromLine.recent.get(studentId) || 0;
    if (now - lastTs < 2000) return;
    recordEventFromLine.recent.set(studentId, now);
    const type = resolveType(studentId, typeExp);
    const ts = nowIso();
    insertEvent.run(studentId, type, ts);
    recordEventFromLine.window = { at: 0, id: null };
    recordEventFromLine.lastMove = null;
    try {
      const p = getParentByStudent.get(studentId);
      if (p && p.email) {
        const s = getStudent.get(studentId);
        const label = s ? (s.kind === "escolar" && s.name && s.grade ? `${s.name} (${s.grade})` : (s.kind === "universitario" && s.code ? s.code : s.id)) : studentId;
        const subject = `Registro ${type}`;
        const text = `Registro de asistencia\nAlumno: ${label}\nEvento: ${type}\nHora: ${new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}`;
        trySendEmail(p.email, subject, text);
      }
    } catch {}
    if (CLOUD_ENDPOINT) {
      const payload = { student_id: studentId, type, ts };
      try { fetch(CLOUD_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {}); } catch {}
    }
    const payload = { student_id: studentId, type, ts };
    for (const res of sseClients) { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} }
    // Notificaciones y SSE más abajo
  } else {
    const parsed = parseLine(line);
    if (!parsed) return;
    const exists = getStudent.get(parsed.studentId) || getStudentByCode.get(parsed.studentId);
    if (STRICT_IDS && !exists) return;
    const now = Date.now();
    if (!recordEventFromLine.window) recordEventFromLine.window = { at: 0, id: null };
    if (now - recordEventFromLine.window.at < SCAN_WINDOW_MS) {
      if (parsed.studentId !== recordEventFromLine.window.id) return;
      recordEventFromLine.window.at = now;
    } else {
      recordEventFromLine.window.at = now;
      recordEventFromLine.window.id = parsed.studentId;
    }
    if (!recordEventFromLine.recent) recordEventFromLine.recent = new Map();
    const lastTs = recordEventFromLine.recent.get(parsed.studentId) || 0;
    if (now - lastTs < 2000) return;
    recordEventFromLine.recent.set(parsed.studentId, now);
    const type = resolveType(parsed.studentId, parsed.type);
    const ts = nowIso();
    insertEvent.run(parsed.studentId, type, ts);
    recordEventFromLine.window = { at: 0, id: null };
    try {
      const p = getParentByStudent.get(parsed.studentId);
      if (p && p.email) {
        const s = getStudent.get(parsed.studentId);
        const label = s ? (s.kind === "escolar" && s.name && s.grade ? `${s.name} (${s.grade})` : (s.kind === "universitario" && s.code ? s.code : s.id)) : parsed.studentId;
        const subject = `Registro ${type}`;
        const text = `Registro de asistencia\nAlumno: ${label}\nEvento: ${type}\nHora: ${new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}`;
        trySendEmail(p.email, subject, text);
      }
    } catch {}
    if (CLOUD_ENDPOINT) {
      const payload = { student_id: parsed.studentId, type, ts };
      try { fetch(CLOUD_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {}); } catch {}
    }
    const payload = { student_id: parsed.studentId, type, ts };
    for (const res of sseClients) { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} }
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
  const port = new SerialPort({ path: serialPath, baudRate: SERIAL_BAUD, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: true });
  portInstances.set(serialPath, port);
  port.on("open", () => {
    console.log(`Serial escuchando en ${serialPath} @ ${SERIAL_BAUD}`);
    openedPorts.add(serialPath);
    try { port.flush(() => {}); } catch {}
  });
  const parser = new ReadlineParser({ delimiter: '\n' });
  port.pipe(parser);
  parser.on("data", line => {
    const text = String(line || "").replace(/\r+$/, '').trim();
    if (!text) return;
    rawLog.push(text);
    if (rawLog.length > 100) rawLog.shift();
    recordEventFromLine(text);
  });
  port.on("error", err => {
    console.warn(`Error serial en ${serialPath}: ${err && err.message ? err.message : String(err)}`);
    openedPorts.delete(serialPath);
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
  if (!isAuthenticated(req)) { res.status(403).json({ ok: false }); return; }
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

app.get("/api/raw", (req, res) => {
  res.json({ lines: rawLog.slice(-50) });
});

app.get("/api/debug/parse", (req, res) => {
  const q = req.query || {};
  const line = String(q.line || "");
  res.json({ parsed: parseLine(line) });
});

app.post("/api/debug/scan", (req, res) => {
  const b = req.body || {};
  const line = String(b.line || "");
  recordEventFromLine(line);
  res.json({ ok: true, parsed: parseLine(line) });
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

app.get("/api/attendance", (req, res) => {
  const q = req.query || {};
  const kind = String(q.kind || "");
  const id = q.id ? String(q.id) : null;
  const code = q.code ? String(q.code) : null;
  const sid = q.sid ? String(q.sid) : null;
  const name = q.name ? String(q.name) : null;
  let student = null;
  if (sid) {
    student = getStudent.get(sid) || getStudentByCode.get(sid);
  }
  if (!student && kind === "escolar" && name) {
    student = getStudentByName.get(name);
  }
  if (!student) {
    if (kind === "escolar" && id) student = getStudent.get(id);
    if (kind === "universitario" && code) student = getStudentByCode.get(code);
  }
  if (!student) {
    const lookupId = sid || (kind === "escolar" ? id : (kind === "universitario" ? (code && /^\d+$/.test(String(code)) ? String(code) : null) : null));
    if (lookupId) {
      const { start, end } = dayBounds(q.date);
      const rows = selectEventsForStudentBetween.all(lookupId, start, end);
      const last = rows[0] || null;
      const present = last ? last.type === "entrada" : false;
      res.json({ student: { id: lookupId, kind: kind || (sid ? "auto" : "escolar"), name: null, grade: null, code: sid || null }, present, last });
      return;
    }
    res.status(404).json({ ok: false });
    return;
  }
  const { start, end } = dayBounds(q.date);
  const rows = selectEventsForStudentBetween.all(student.id, start, end);
  const last = rows[0] || null;
  const present = last ? last.type === "entrada" : false;
  res.json({ student, present, last });
});

app.post("/api/reset", (req, res) => {
  if (!isAuthenticated(req)) { res.status(403).json({ ok: false }); return; }
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

 

app.post("/api/parents/email", async (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || "");
  const email = String(b.email || "").trim();
  const sid = b.sid ? String(b.sid) : null;
  const name = b.name ? String(b.name) : null;
  let student = null;
  if (kind === "escolar" && b.id) student = getStudent.get(String(b.id));
  if (kind === "universitario" && b.code) student = getStudentByCode.get(String(b.code));
  if (!student && kind === "escolar" && name) student = getStudentByName.get(String(name));
  let studentId = student ? student.id : null;
  if (!studentId && sid) studentId = sid;
  if (!studentId && kind === "escolar" && b.id) studentId = String(b.id);
  if (!studentId && kind === "universitario" && b.code && /^\d+$/.test(String(b.code))) studentId = String(b.code);
  if (!studentId || !email) { res.status(400).json({ ok: false }); return; }
  upsertParent.run(studentId, b.name ? String(b.name) : null, null, b.phone ? String(b.phone) : null, email);
  let sent = false;
  try {
    const s = getStudent.get(studentId) || null;
    const label = s ? (s.kind === "escolar" && s.name && s.grade ? `${s.name} (${s.grade})` : (s.kind === "universitario" && s.code ? s.code : s.id)) : studentId;
    const subject = "Notificaciones activadas";
    const text = `Has activado las notificaciones por correo para: ${label}.\nRecibirás un correo en cada ingreso/salida.`;
    sent = await trySendEmail(email, subject, text);
  } catch {}
  res.json({ ok: true, sent });
});

app.post("/api/test-email", (req, res) => {
  const b = req.body || {};
  const toRaw = String(b.to || "").trim();
  const sid = b.student_id ? String(b.student_id) : null;
  let target = null;
  if (sid) {
    try {
      const p = getParentByStudent.get(sid);
      if (p && p.email) target = String(p.email);
    } catch {}
  }
  if (!target && toRaw) target = toRaw;
  if (!target) { res.status(400).json({ ok: false, error: "missing_target" }); return; }
  const subject = "Prueba de notificación";
  const text = "Este es un correo de prueba de Registro y control.";
  trySendEmail(target, subject, text).then(ok => {
    if (ok) res.json({ ok: true, to: target });
    else res.status(500).json({ ok: false, error: "send_failed" });
  });
});

app.post("/api/simulate-scan", (req, res) => {
  const b = req.body || {};
  const studentId = String(b.student_id || "").trim();
  const typeRaw = String(b.type || "").trim();
  if (!studentId) { res.status(400).json({ ok: false, error: "missing_student_id" }); return; }
  const exists = getStudent.get(studentId) || getStudentByCode.get(studentId);
  if (!exists) { res.status(404).json({ ok: false, error: "student_not_found" }); return; }
  const type = typeRaw === "entrada" || typeRaw === "salida" ? typeRaw : resolveType(studentId, null);
  const ts = nowIso();
  insertEvent.run(studentId, type, ts);
  try {
    const p = getParentByStudent.get(studentId);
    if (p && p.email) {
      const s = getStudent.get(studentId);
      const label = s ? (s.kind === "escolar" && s.name && s.grade ? `${s.name} (${s.grade})` : (s.kind === "universitario" && s.code ? s.code : s.id)) : studentId;
      const subject = `Registro ${type}`;
      const text = `Registro de asistencia\nAlumno: ${label}\nEvento: ${type}\nHora: ${new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })}`;
      trySendEmail(p.email, subject, text);
    }
  } catch {}
  res.json({ ok: true, student_id: studentId, type, ts });
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

app.get('/parent.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/parent-dashboard.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/parent-stats.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});

app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  initSerial();
  console.log(`Servidor listo en http://localhost:${PORT}`);
  try { console.log(parseLine("ESTUDIANTE:1:Juan Perez:ESTADO:FUERA")); } catch {}
});