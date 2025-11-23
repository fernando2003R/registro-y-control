function toggleMode(){
  const m = document.getElementById('mode').value;
  document.getElementById('adminForm').style.display = m === 'admin' ? 'block' : 'none';
  document.getElementById('studentForm').style.display = m === 'student' ? 'block' : 'none';
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
toggleMode();
toggleFields();