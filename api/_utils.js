function dayBounds(dateStr){
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const start = new Date(d); start.setHours(0,0,0,0);
  const end = new Date(d); end.setHours(23,59,59,999);
  return { start: start.toISOString(), end: end.toISOString(), date: start.toISOString().slice(0,10) };
}

module.exports = { dayBounds };