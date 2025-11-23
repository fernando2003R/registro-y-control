async function fetchJSON(url){
  const res = await fetch(url);
  return res.json();
}

function drawBars(canvas, labels, series){
  const ctx = canvas.getContext('2d');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * window.devicePixelRatio;
  canvas.height = height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  ctx.clearRect(0,0,width,height);
  const padding = 30;
  const plotW = width - padding*2;
  const plotH = height - padding*2;
  const groups = labels.length;
  const barsPerGroup = series.length; // e.g., entradas, salidas
  const maxVal = Math.max(1, ...series.flat());
  const groupW = plotW / groups;
  const barW = groupW * 0.8 / barsPerGroup;

  // axes
  ctx.strokeStyle = '#ccc';
  ctx.beginPath();
  ctx.moveTo(padding, height - padding);
  ctx.lineTo(width - padding, height - padding);
  ctx.moveTo(padding, height - padding);
  ctx.lineTo(padding, padding);
  ctx.stroke();

  const colors = ['#198754','#dc3545'];
  for (let i = 0; i < groups; i++){
    const gx = padding + i*groupW + (groupW*0.2)/2;
    for (let s = 0; s < barsPerGroup; s++){
      const val = series[s][i] || 0;
      const barH = (val / maxVal) * (plotH);
      const x = gx + s*barW;
      const y = height - padding - barH;
      ctx.fillStyle = colors[s % colors.length];
      ctx.fillRect(x, y, barW, barH);
    }
    // x labels every 2 hours
    if (i % 2 === 0){
      ctx.fillStyle = '#555';
      ctx.font = '12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(String(labels[i]).padStart(2,'0'), gx + (barsPerGroup*barW)/2, height - padding + 14);
    }
  }

  // legend
  const legends = ['Entradas','Salidas'];
  let lx = width - padding - 160;
  let ly = padding;
  legends.forEach((name, idx) => {
    ctx.fillStyle = colors[idx];
    ctx.fillRect(lx, ly, 14, 14);
    ctx.fillStyle = '#111';
    ctx.textAlign = 'left';
    ctx.fillText(name, lx+20, ly+12);
    ly += 20;
  });
}

function renderTopStudents(rows){
  const tbody = document.getElementById('topBody');
  tbody.innerHTML = rows.map(r => `<tr><td>${r.student_id}</td><td>${r.entradas}</td><td>${r.salidas}</td><td>${r.total}</td></tr>`).join('');
}

function drawLines(canvas, points, seriesKeys, colors){
  const ctx = canvas.getContext('2d');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * window.devicePixelRatio;
  canvas.height = height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  ctx.clearRect(0,0,width,height);
  const padding = 30;
  const plotW = width - padding*2;
  const plotH = height - padding*2;
  const maxVal = points.length ? Math.max(1, ...points.map(p => Math.max(...seriesKeys.map(k => p[k])))) : 1;
  ctx.strokeStyle = '#ccc';
  ctx.beginPath();
  ctx.moveTo(padding, height - padding);
  ctx.lineTo(width - padding, height - padding);
  ctx.moveTo(padding, height - padding);
  ctx.lineTo(padding, padding);
  ctx.stroke();
  const stepX = points.length ? plotW / (points.length - 1) : plotW;
  seriesKeys.forEach((key, idx) => {
    ctx.strokeStyle = colors[idx];
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = padding + i*stepX;
      const y = height - padding - (p[key] / maxVal) * plotH;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

let currentRange = null;

async function refresh(){
  let url = '/api/metrics/day';
  if (currentRange && currentRange.start && currentRange.end){
    const params = new URLSearchParams({ start: currentRange.start, end: currentRange.end });
    url = '/api/metrics/range?' + params.toString();
  }
  const data = await fetchJSON(url);
  const canvas = document.getElementById('chartHours');
  drawBars(canvas, data.hours.labels, [data.hours.entradas, data.hours.salidas]);
  renderTopStudents(data.topStudents);
  const ph = document.getElementById('peakHour');
  const pv = document.getElementById('peakValue');
  const re = document.getElementById('ratioES');
  ph.textContent = String(data.indicators.peakHour).padStart(2,'0') + ':00';
  pv.textContent = data.indicators.peakValue;
  re.textContent = data.indicators.ratioEntradaSalida != null ? data.indicators.ratioEntradaSalida.toFixed(2) : '∞';
  const lastBody = document.getElementById('lastBody');
  lastBody.innerHTML = (data.lastEvents || []).map(r => {
    const d = new Date(r.ts);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cls = r.type === 'entrada' ? 'tipo-entrada' : 'tipo-salida';
    return `<tr><td>${time}</td><td>${r.student_id}</td><td class="${cls}">${r.type}</td></tr>`;
  }).join('');
  const cumCanvas = document.getElementById('chartCum');
  drawLines(cumCanvas, data.cumulative || [], ['entradas','salidas','total'], ['#198754','#dc3545','#0d6efd']);
}

refresh();
setInterval(refresh, 5000);

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

document.getElementById('applyRange').addEventListener('click', () => {
  const s = document.getElementById('startDate').value;
  const e = document.getElementById('endDate').value;
  if (s && e){
    currentRange = { start: s, end: e };
  }
  refresh();
});

document.getElementById('today').addEventListener('click', () => {
  document.getElementById('startDate').value = '';
  document.getElementById('endDate').value = '';
  currentRange = null;
  refresh();
});