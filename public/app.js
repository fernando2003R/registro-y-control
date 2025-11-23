async function fetchJSON(url){
  const res = await fetch(url);
  return res.json();
}

function fmtTime(iso){
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderRows(items){
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = items.map(r => {
    const cls = r.type === 'entrada' ? 'tipo-entrada' : 'tipo-salida';
    const label = r.kind === 'escolar' && r.name && r.grade ? `${r.name} (${r.grade})` : (r.kind === 'universitario' && r.code ? r.code : r.student_id);
    return `<tr><td>${fmtTime(r.ts)}</td><td>${label}</td><td class="${cls}">${r.type}</td></tr>`;
  }).join('');
}

function renderStats(s){
  document.getElementById('presentes').textContent = s.presentes;
  document.getElementById('entradas').textContent = s.entradas;
  document.getElementById('salidas').textContent = s.salidas;
}

async function refresh(){
  const logs = await fetchJSON('/api/logs');
  renderRows(logs.items);
  const stats = await fetchJSON('/api/stats');
  renderStats(stats);
}

refresh();
setInterval(refresh, 5000);

async function resetAll(){
  const ok = window.confirm('¿Seguro que quieres reiniciar el registro? Se borrarán todos los eventos.');
  if (!ok) return;
  try {
    const res = await fetch('/api/reset', { method: 'POST' });
    if (!res.ok) throw new Error('Error al reiniciar');
    await refresh();
  } catch (e) {
    alert('No se pudo reiniciar el registro');
  }
}

document.getElementById('reset').addEventListener('click', resetAll);
document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

let es;
function connectStream(){
  try {
    es = new EventSource('/api/stream');
    es.onmessage = () => { refresh(); };
    es.onerror = () => { try { es.close(); } catch {}; setTimeout(connectStream, 3000); };
  } catch (e) { setTimeout(connectStream, 3000); }
}
connectStream();