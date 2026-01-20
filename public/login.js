function toggleMode(){
  const m = document.getElementById('mode').value;
  document.getElementById('adminForm').style.display = m === 'admin' ? 'block' : 'none';
  document.getElementById('studentForm').style.display = m === 'student' ? 'block' : 'none';
  document.getElementById('parentForm').style.display = m === 'parent' ? 'block' : 'none';
}

function toggleFields(){
  const k = document.getElementById('kind').value;
  document.getElementById('escolarFields').style.display = k === 'escolar' ? 'block' : 'none';
  document.getElementById('uniFields').style.display = k === 'universitario' ? 'block' : 'none';
}

async function doLogin(){
  const code = document.getElementById('code').value.trim();
  const msg = document.getElementById('msg');
  msg.textContent = '';
  try{
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    if (!res.ok){
      msg.textContent = 'Código incorrecto';
      return;
    }
    window.location.href = '/';
  }catch(e){
    msg.textContent = 'Error de conexión';
  }
}

async function saveStudent(){
  const kind = document.getElementById('kind').value;
  const id = document.getElementById('id').value.trim();
  const name = document.getElementById('name').value.trim();
  const grade = document.getElementById('grade').value.trim();
  const code = document.getElementById('stu_code').value.trim();
  const msg = document.getElementById('msg');
  msg.textContent = '';
  msg.className = 'msg';
  if (!id){ msg.textContent = 'Debes ingresar tu ID del lector.'; msg.classList.add('err'); return; }
  const body = { id, kind };
  if (kind === 'escolar'){ body.name = name; body.grade = grade; }
  else { body.code = code; }
  try{
    const res = await fetch('/api/students', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
    if (!res.ok){ throw new Error('Error'); }
    msg.textContent = 'Guardado';
    msg.classList.add('ok');
  }catch(e){
    msg.textContent = 'No se pudo guardar';
    msg.classList.add('err');
  }
}

document.getElementById('mode').addEventListener('change', toggleMode);
document.getElementById('kind').addEventListener('change', toggleFields);
document.getElementById('go').addEventListener('click', doLogin);
document.getElementById('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
document.getElementById('save').addEventListener('click', saveStudent);
// sin alternar campos: usamos un único campo `p_sid`
async function checkParent(){
  const kind = document.getElementById('p_kind').value;
  const sid = document.getElementById('p_sid').value.trim();
  const box = document.getElementById('parentResult');
  box.textContent = '';
  const qs = new URLSearchParams(kind === 'escolar' ? { kind, name: sid } : { kind, sid });
  try{
    const res = await fetch('/api/attendance?' + qs.toString());
    if (!res.ok){ box.textContent = 'No encontrado'; return; }
    const data = await res.json();
    const label = data.student && data.student.kind === 'escolar' && data.student.name ? `${data.student.name} (${data.student.grade})` : (data.student && data.student.kind === 'universitario' && data.student.code ? data.student.code : (data.student ? data.student.id : '')); 
    const status = data.present ? 'Asistió hoy' : 'No asistió hoy';
    const last = data.last && data.last.ts ? new Date(data.last.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' + (data.last.type || '') : '';
    box.innerHTML = `<div><strong>${label}</strong></div><div>${status}</div>${last ? `<div>Último evento: ${last}</div>` : ''}`;
  }catch(e){ box.textContent = 'Error de conexión'; }
}
async function enableEmail(){
  const kind = document.getElementById('p_kind').value;
  const sid = document.getElementById('p_sid').value.trim();
  const email = document.getElementById('p_email').value.trim();
  const box = document.getElementById('parentResult');
  box.textContent = '';
  try{
    const body = kind === 'escolar' ? { kind, name: sid, email } : { kind, sid, email };
    const res = await fetch('/api/parents/email', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if (!res.ok){ box.textContent = 'No se pudo activar'; return; }
    const data = await res.json();
    box.textContent = data.sent ? 'Notificaciones por correo activadas (confirmación enviada)' : 'Notificaciones por correo activadas';
  }catch(e){ box.textContent = 'Error de conexión'; }
}
document.getElementById('check').addEventListener('click', checkParent);
document.getElementById('open_parent').addEventListener('click', () => { window.location.href = '/parent.html'; });
document.getElementById('enable_email').addEventListener('click', enableEmail);
document.getElementById('p_kind').addEventListener('change', () => {
  const k = document.getElementById('p_kind').value;
  const label = document.getElementById('p_label');
  const input = document.getElementById('p_sid');
  if (k === 'escolar'){ label.textContent = 'Nombre'; input.placeholder = 'Ej: Juan Perez'; }
  else { label.textContent = 'Código universitario'; input.placeholder = 'Ej: 20231234'; }
});
toggleMode();
toggleFields();
document.getElementById('p_kind').dispatchEvent(new Event('change'));