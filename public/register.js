function toggleFields(){
  const kind = document.getElementById('kind').value;
  document.getElementById('escolarFields').style.display = kind === 'escolar' ? 'block' : 'none';
  document.getElementById('uniFields').style.display = kind === 'universitario' ? 'block' : 'none';
}

async function save(){
  const kind = document.getElementById('kind').value;
  const id = document.getElementById('id').value.trim();
  const name = document.getElementById('name').value.trim();
  const grade = document.getElementById('grade').value.trim();
  const code = document.getElementById('code').value.trim();
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

document.getElementById('kind').addEventListener('change', toggleFields);
document.getElementById('save').addEventListener('click', save);
toggleFields();