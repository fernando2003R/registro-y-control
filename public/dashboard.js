async function fetchJSON(url){
  const res = await fetch(url);
  return res.json();
}

function renderStats(s){
  document.getElementById('presentes').textContent = s.presentes;
  document.getElementById('entradas').textContent = s.entradas;
  document.getElementById('salidas').textContent = s.salidas;
  document.getElementById('eventos').textContent = s.entradas + s.salidas;
}

async function refresh(){
  const stats = await fetchJSON('/api/stats');
  renderStats(stats);
}

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
document.getElementById('reconnect').addEventListener('click', async () => {
  try { await fetch('/api/reconnect', { method: 'POST' }); } catch {}
});
refresh();
setInterval(refresh, 5000);