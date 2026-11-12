/* Gestor de Cumplimiento Legal EHS — app estática (GitHub Pages) con carpeta local de datos.
   El repositorio solo contiene código y catálogo; los datos de la empresa viven en la carpeta elegida. */
'use strict';

// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hoy = () => new Date().toISOString().slice(0, 10);
const mesActual = () => hoy().slice(0, 7);
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const urlSegura = u => /^https?:\/\//i.test(u || '') ? u : '';
const nombreSeguro = n => String(n).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);

const ESTATUS = {
  cumple: { es: 'Cumple', en: 'Compliant', v: 1 },
  proceso: { es: 'En proceso', en: 'In progress', v: 0.5 },
  no_cumple: { es: 'No cumple', en: 'Non-compliant', v: 0 },
  na: { es: 'No aplica', en: 'N/A', v: null },
  sin_evaluar: { es: 'Sin evaluar', en: 'Not assessed', v: 0 }
};
const PERFIL = [
  ['subcontratacion', '¿Contrata servicios especializados (subcontratación)?'],
  ['sustancias_quimicas', '¿Maneja, transporta o almacena sustancias químicas peligrosas?'],
  ['trabajos_altura', '¿Se realizan trabajos en altura?'],
  ['recipientes_presion', '¿Tiene recipientes sujetos a presión, criogénicos o calderas?'],
  ['electricidad_estatica', '¿Hay áreas con riesgo por electricidad estática?'],
  ['fuentes_fijas', '¿Tiene fuentes fijas de emisiones a la atmósfera (chimeneas, calderas, hornos)?'],
  ['suelo_contaminado', '¿Existe o ha existido contaminación de suelo / pasivos ambientales?']
];
const T = {
  es: { global: 'Cumplimiento global', aplicables: 'Requisitos aplicables', nocumple: 'No cumplen', proceso: 'En proceso', sinev: 'Sin evidencia', tvenc: 'Tareas vencidas', evenc: 'Evidencia por vencer (60 días)', porCat: 'Cumplimiento por categoría', tend: 'Tendencia mensual', prox: 'Próximos vencimientos', criticos: 'Puntos que no cumplen', imprimir: 'Imprimir reporte', sinDatos: 'Sin datos todavía' },
  en: { global: 'Overall compliance', aplicables: 'Applicable requirements', nocumple: 'Non-compliant', proceso: 'In progress', sinev: 'No evidence', tvenc: 'Overdue tasks', evenc: 'Evidence expiring (60 days)', porCat: 'Compliance by category', tend: 'Monthly trend', prox: 'Upcoming due dates', criticos: 'Non-compliant items', imprimir: 'Print report', sinDatos: 'No data yet' }
};

// ---------- estado ----------
let catalogos = [];           // módulos cargados del repo
let novedadesRepo = { actualizado: '', novedades: [] };
let db = dbVacia();
let dirHandle = null;         // carpeta de datos (File System Access API)
let cargadoTs = null;         // marca de tiempo del datos.json leído
let sucio = false;
let vista = 'dashboard';
let lang = 'es';
let filtros = { modulo: '', estatus: '', q: '', sinEv: false };
const FS_OK = 'showDirectoryPicker' in window;

function dbVacia() {
  return { version: 1, empresa: { nombre: '', estado: '', municipio: '', perfil: {} }, estados: {}, evidencias: [], tareas: [],
    historial: {}, novedades: {}, reqsPropios: [], ediciones: {}, meta: { ts: null, usuario: '' } };
}
function normalizar(d) { return Object.assign(dbVacia(), d, { empresa: Object.assign(dbVacia().empresa, d.empresa || {}) }); }

function reqs() {
  const out = [];
  for (const m of catalogos) for (const r of m.requisitos) out.push(aplicarEd(r));
  for (const r of db.reqsPropios) out.push(aplicarEd(r));
  return out;
}
function aplicarEd(r) {
  const e = db.ediciones[r.id];
  return e ? Object.assign({}, r, { ref: Object.assign({}, r.ref, e.ref || {}), guia: e.guia ?? r.guia, guiaEstado: e.guia != null ? 'usuario' : r.guiaEstado, refEstado: e.ref ? 'usuario' : r.refEstado }) : r;
}
const modulos = () => {
  const ms = catalogos.map(m => ({ id: m.id, nombre: m.nombre, nombre_en: m.nombre_en || m.nombre }));
  for (const r of db.reqsPropios) if (!ms.some(m => m.id === r.modulo)) ms.push({ id: r.modulo, nombre: r.modulo, nombre_en: r.modulo });
  return ms;
};
const est = id => (db.estados[id] && db.estados[id].estatus) || 'sin_evaluar';
const evDe = id => db.evidencias.filter(e => e.reqId === id);
const refTxt = r => [r.ref.nom, r.ref.ley, r.ref.reglamento, r.ref.articulo && ('Art./numeral ' + r.ref.articulo)].filter(Boolean).join(' · ');

function resumen(lista) {
  const c = { cumple: 0, proceso: 0, no_cumple: 0, na: 0, sin_evaluar: 0 };
  for (const r of lista) c[est(r.id)]++;
  const apl = lista.length - c.na;
  const pct = apl ? (c.cumple + 0.5 * c.proceso) / apl : null;
  return Object.assign(c, { apl, pct });
}
const fpct = p => p == null ? '—' : Math.round(p * 100) + '%';
function marcar() { sucio = true; pintarEstado(); }

// ---------- persistencia ----------
const idb = {
  open: () => new Promise((ok, no) => { const r = indexedDB.open('cumplimiento', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }),
  async get(k) { const d = await this.open(); return new Promise(ok => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); }); },
  async set(k, v) { const d = await this.open(); return new Promise(ok => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = ok; t.onerror = ok; }); }
};
async function leerArchivo(dir, nombre) {
  try { const fh = await dir.getFileHandle(nombre); return await (await fh.getFile()).text(); } catch { return null; }
}
async function escribirArchivo(dir, nombre, contenido) {
  const fh = await dir.getFileHandle(nombre, { create: true });
  const w = await fh.createWritable(); await w.write(contenido); await w.close();
}
async function elegirCarpeta() {
  if (!FS_OK) return alert('Este navegador no permite trabajar con carpetas. Usa Chrome o Edge en PC, o usa Respaldo/Restaurar.');
  try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
  await idb.set('dir', dirHandle);
  await cargarDeCarpeta();
}
async function reconectar() {
  const h = await idb.get('dir').catch(() => null);
  if (!h) return false;
  if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    banner(`Carpeta de datos "<b>${esc(h.name)}</b>" recordada. <button id="bReconectar">Reconectar</button>`);
    $('#bReconectar').onclick = async () => { if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') { dirHandle = h; banner(''); await cargarDeCarpeta(); } };
    return false;
  }
  dirHandle = h; await cargarDeCarpeta(); return true;
}
async function cargarDeCarpeta() {
  const txt = await leerArchivo(dirHandle, 'datos.json');
  if (txt) { db = normalizar(JSON.parse(txt)); cargadoTs = db.meta.ts; }
  else { cargadoTs = null; if (!confirm('La carpeta no tiene datos.json. ¿Usar aquí los datos que tienes abiertos ahora?\n(Cancelar = empezar en blanco en esta carpeta)')) db = dbVacia(); }
  sucio = !txt; render();
}
async function guardar() {
  db.meta.usuario = localStorage.getItem('usuario') || db.meta.usuario || '';
  foto();
  if (dirHandle) {
    const actual = await leerArchivo(dirHandle, 'datos.json');
    if (actual) {
      const m = (JSON.parse(actual).meta) || {};
      if (m.ts && m.ts !== cargadoTs && !confirm(`Otra persona (${m.usuario || 'desconocido'}) guardó cambios el ${new Date(m.ts).toLocaleString()} después de que abriste los datos.\n\nAceptar = sobrescribir con tu versión.\nCancelar = no guardar (recarga la página para ver sus cambios).`)) return;
    }
    db.meta.ts = Date.now(); cargadoTs = db.meta.ts;
    await escribirArchivo(dirHandle, 'datos.json', JSON.stringify(db, null, 1));
  } else {
    db.meta.ts = Date.now();
    try { localStorage.setItem('cumplimiento_db', JSON.stringify(db)); } catch { alert('No se pudo guardar en el navegador (espacio lleno). Descarga un respaldo.'); return; }
  }
  sucio = false; pintarEstado();
}
function foto() { // foto mensual para la tendencia
  const mods = {}; for (const m of modulos()) mods[m.id] = resumen(reqs().filter(r => r.modulo === m.id)).pct;
  db.historial[mesActual()] = { global: resumen(reqs()).pct, modulos: mods };
}
function descargar(nombre, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function respaldo() {
  const zip = new JSZip(); zip.file('datos.json', JSON.stringify(db, null, 1));
  if (dirHandle) {
    let ev; try { ev = await dirHandle.getDirectoryHandle('evidencia'); } catch { ev = null; }
    if (ev) for await (const [carp, h] of ev.entries()) if (h.kind === 'directory')
      for await (const [n, fh] of h.entries()) if (fh.kind === 'file') zip.file(`evidencia/${carp}/${n}`, await fh.getFile());
  }
  descargar(`respaldo_cumplimiento_${hoy()}.zip`, await zip.generateAsync({ type: 'blob' }));
}
async function restaurar(file) {
  if (Object.keys(db.estados).length && !confirm('Ya hay datos abiertos. ¿Reemplazarlos con los del archivo?')) return;
  let datos;
  if (/\.json$/i.test(file.name)) datos = JSON.parse(await file.text());
  else {
    const zip = await JSZip.loadAsync(file); const f = zip.file('datos.json');
    if (!f) return alert('El ZIP no contiene datos.json');
    datos = JSON.parse(await f.async('string'));
    if (dirHandle) for (const p of Object.keys(zip.files)) {
      const m = p.match(/^evidencia\/([^/]+)\/([^/]+)$/); if (!m) continue;
      const d = await (await dirHandle.getDirectoryHandle('evidencia', { create: true })).getDirectoryHandle(m[1], { create: true });
      await escribirArchivo(d, m[2], await zip.files[p].async('blob'));
    } else if (Object.keys(zip.files).some(p => p.startsWith('evidencia/'))) alert('Se restauraron los datos. Para restaurar también los archivos de evidencia, primero conecta una carpeta y vuelve a restaurar.');
  }
  db = normalizar(datos); marcar(); render();
}
function exportarCSV() {
  const f = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const filas = [['ID', 'Módulo', 'Categoría', 'Requisito', 'Referencia normativa', 'Estatus', 'Nota', 'Evidencias', 'Tareas abiertas']];
  for (const r of reqs()) filas.push([r.id, r.modulo, r.categoria, r.texto, refTxt(r), ESTATUS[est(r.id)].es, (db.estados[r.id] || {}).nota || '',
    evDe(r.id).map(e => e.nombre).join(' | '), db.tareas.filter(t => t.reqId === r.id && t.estado !== 'cerrada').map(t => t.titulo).join(' | ')]);
  descargar(`matriz_cumplimiento_${hoy()}.csv`, new Blob(['﻿' + filas.map(x => x.map(f).join(',')).join('\r\n')], { type: 'text/csv' }));
}

// ---------- interfaz general ----------
function banner(html) { const b = $('#banner'); b.hidden = !html; b.innerHTML = html; }
function pintarEstado() {
  $('#saveState').textContent = (dirHandle ? '📁 ' + dirHandle.name : 'Sin carpeta (navegador)') + (sucio ? ' · cambios sin guardar' : ' · guardado');
  $('#empresaNombre').textContent = db.empresa.nombre || '';
  const hoyS = hoy();
  const tv = db.tareas.filter(t => t.estado !== 'cerrada' && t.vence && t.vence < hoyS).length;
  $('#badgeTareas').hidden = !tv; $('#badgeTareas').textContent = tv;
  const np = novedadesRepo.novedades.filter(n => !db.novedades[n.id]).length;
  $('#badgeNov').hidden = !np; $('#badgeNov').textContent = np;
}
function render() {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === vista));
  ({ dashboard: vDashboard, requisitos: vRequisitos, tareas: vTareas, novedades: vNovedades, config: vConfig }[vista])();
  pintarEstado();
}

// ---------- tablero ----------
function vDashboard() {
  const t = T[lang], L = lang, all = reqs(), g = resumen(all), hoyS = hoy();
  const en60 = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const sinEv = all.filter(r => est(r.id) === 'cumple' && !evDe(r.id).length).length;
  const tv = db.tareas.filter(x => x.estado !== 'cerrada' && x.vence && x.vence < hoyS);
  const ev = db.evidencias.filter(e => e.vence && e.vence <= en60);
  const kpi = (n, l, alerta) => `<div class="card kpi ${alerta ? 'alerta' : ''}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const barras = lista => {
    const cats = [...new Set(lista.map(r => r.categoria))];
    return cats.map(c => { const s = resumen(lista.filter(r => r.categoria === c)); const w = k => s.apl ? (s[k] / s.apl * 100) : 0;
      return `<div class="bar-row"><span class="name" title="${esc(c)}">${esc(c)}</span><span class="bar" role="img" aria-label="${esc(c)}: ${fpct(s.pct)}"><i class="c" style="width:${w('cumple')}%"></i><i class="p" style="width:${w('proceso')}%"></i><i class="n" style="width:${w('no_cumple')}%"></i><i class="s" style="width:${w('sin_evaluar')}%"></i></span><span class="pct">${fpct(s.pct)}</span></div>`; }).join('');
  };
  const leyenda = `<div class="legend"><span style="--k:var(--ok)">${ESTATUS.cumple[L]}</span><span style="--k:var(--proc)">${ESTATUS.proceso[L]}</span><span style="--k:var(--no)">${ESTATUS.no_cumple[L]}</span><span style="--k:#aab2be">${ESTATUS.sin_evaluar[L]}</span></div>`;
  const criticos = all.filter(r => est(r.id) === 'no_cumple');
  const prox = [...db.tareas.filter(x => x.estado !== 'cerrada' && x.vence).map(x => ({ f: x.vence, txt: x.titulo, id: x.reqId, tipo: 'Tarea' })),
    ...ev.map(e => ({ f: e.vence, txt: e.nombre, id: e.reqId, tipo: 'Evidencia' }))].sort((a, b) => a.f.localeCompare(b.f)).slice(0, 12);
  $('#main').innerHTML = `
  <div class="grid kpis">
    ${kpi(fpct(g.pct), t.global)}
    ${modulos().map(m => kpi(fpct(resumen(all.filter(r => r.modulo === m.id)).pct), esc(L === 'en' ? m.nombre_en : m.nombre))).join('')}
    ${kpi(g.apl, t.aplicables)}${kpi(g.no_cumple, t.nocumple, g.no_cumple)}${kpi(g.proceso, t.proceso)}
    ${kpi(sinEv, t.sinev, sinEv)}${kpi(tv.length, t.tvenc, tv.length)}${kpi(ev.length, t.evenc, ev.length)}
  </div>
  <p class="noprint" style="margin:.8rem 0"><button onclick="print()">${t.imprimir}</button></p>
  <div class="grid cols2">
    ${modulos().map(m => `<div class="card"><h2>${t.porCat} — ${esc(L === 'en' ? m.nombre_en : m.nombre)}</h2>${leyenda}${barras(all.filter(r => r.modulo === m.id)) || t.sinDatos}</div>`).join('')}
    <div class="card"><h2>${t.tend}</h2>${tendencia()}</div>
    <div class="card"><h2>${t.prox}</h2>${prox.length ? prox.map(p => `<div class="item"><span><span class="${p.f < hoyS ? 'vencida' : ''}">${p.f}</span> · ${p.tipo}: ${esc(p.txt)}</span>${p.id ? `<button class="link" data-open="${esc(p.id)}">${esc(p.id)}</button>` : ''}</div>`).join('') : `<span class="muted">${t.sinDatos}</span>`}</div>
    <div class="card"><h2>${t.criticos}</h2>${criticos.length ? criticos.map(r => `<div class="item"><span>${esc(r.texto.slice(0, 140))}</span><button class="link" data-open="${esc(r.id)}">${esc(r.id)}</button></div>`).join('') : `<span class="muted">—</span>`}</div>
  </div>`;
}
function tendencia() {
  const meses = Object.keys(db.historial).sort().slice(-12);
  if (!meses.length) return `<span class="muted">${T[lang].sinDatos}. Se registra una foto del mes cada vez que guardas.</span>`;
  const W = 520, H = 190, px = 36, py = 18, x = i => px + (meses.length === 1 ? (W - 2 * px) / 2 : i * (W - 2 * px) / (meses.length - 1)), y = v => H - 26 - v * (H - 26 - py);
  const series = [{ k: 'global', n: 'Global', c: '#1c2430', d: '' }, ...modulos().map((m, i) => ({ k: m.id, n: lang === 'en' ? m.nombre_en : m.nombre, c: ['#28508E', '#901812', '#1f7a4d', '#b26a00'][i % 4], d: i % 2 ? '5 3' : '' }))];
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${T[lang].tend}">`;
  for (const v of [0, .5, 1]) s += `<line x1="${px}" x2="${W - px}" y1="${y(v)}" y2="${y(v)}" stroke="#d9dee5"/><text x="4" y="${y(v) + 4}">${v * 100}%</text>`;
  meses.forEach((m, i) => s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${m.slice(2)}</text>`);
  for (const se of series) {
    const pts = meses.map((m, i) => { const h = db.historial[m], v = se.k === 'global' ? h.global : (h.modulos || {})[se.k]; return v == null ? null : [x(i), y(v), v]; }).filter(Boolean);
    if (!pts.length) continue;
    s += `<polyline fill="none" stroke="${se.c}" stroke-width="2" stroke-dasharray="${se.d}" points="${pts.map(p => p[0] + ',' + p[1]).join(' ')}"/>`;
    pts.forEach(p => s += `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${se.c}"><title>${esc(se.n)}: ${fpct(p[2])}</title></circle>`);
    const u = pts[pts.length - 1]; s += `<text x="${Math.min(u[0] + 6, W - 34)}" y="${u[1] - 6}" style="fill:${se.c}">${fpct(u[2])}</text>`;
  }
  s += '</svg><div class="legend">' + series.map(se => `<span style="--k:${se.c}">${esc(se.n)}</span>`).join('') + '</div>';
  return s;
}

// ---------- requisitos (binder) ----------
function vRequisitos() {
  const f = filtros, q = f.q.toLowerCase();
  const lista = reqs().filter(r => (!f.modulo || r.modulo === f.modulo) && (!f.estatus || est(r.id) === f.estatus) &&
    (!f.sinEv || !evDe(r.id).length) && (!q || (r.texto + ' ' + r.categoria + ' ' + refTxt(r) + ' ' + r.id).toLowerCase().includes(q)));
  let html = `<div class="filters">
    <input type="search" id="fq" placeholder="Buscar requisito, NOM, artículo…" value="${esc(f.q)}">
    <select id="fm"><option value="">Todos los módulos</option>${modulos().map(m => `<option value="${esc(m.id)}" ${f.modulo === m.id ? 'selected' : ''}>${esc(m.nombre)}</option>`).join('')}</select>
    <select id="fe"><option value="">Todos los estatus</option>${Object.keys(ESTATUS).map(k => `<option value="${k}" ${f.estatus === k ? 'selected' : ''}>${ESTATUS[k].es}</option>`).join('')}</select>
    <label style="margin:0"><input type="checkbox" id="fs" ${f.sinEv ? 'checked' : ''}> Sin evidencia</label>
    <span class="muted">${lista.length} puntos</span>
    <button id="bCsv">Exportar matriz (CSV)</button>
  </div><table><thead><tr><th style="width:7rem">ID</th><th>Requisito</th><th style="width:22%">Referencia</th><th style="width:7.5rem">Estatus</th><th style="width:5rem">Evid.</th><th style="width:5rem">Tareas</th></tr></thead><tbody>`;
  let cat = null;
  for (const r of lista) {
    const c = r.modulo + '|' + r.categoria;
    if (c !== cat) { cat = c; html += `<tr class="cat"><td colspan="6">${esc(r.categoria)} <span class="tag">${fpct(resumen(lista.filter(x => x.modulo + '|' + x.categoria === c)).pct)}</span></td></tr>`; }
    const e = est(r.id), nt = db.tareas.filter(t => t.reqId === r.id && t.estado !== 'cerrada').length;
    html += `<tr class="req" data-open="${esc(r.id)}"><td>${esc(r.id)}</td><td>${esc(r.texto)}</td><td class="muted">${esc(refTxt(r)) || '<span class="tag warn">sin cita</span>'}</td><td><span class="pill ${e}">${ESTATUS[e].es}</span></td><td>${evDe(r.id).length || '—'}</td><td>${nt || '—'}</td></tr>`;
  }
  $('#main').innerHTML = html + '</tbody></table>';
  const upd = () => { filtros = { q: $('#fq').value, modulo: $('#fm').value, estatus: $('#fe').value, sinEv: $('#fs').checked }; vRequisitos(); const i = $('#fq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); };
  $('#fq').oninput = upd; $('#fm').onchange = upd; $('#fe').onchange = upd; $('#fs').onchange = upd; $('#bCsv').onclick = exportarCSV;
}

function abrirPanel(id) {
  const r = reqs().find(x => x.id === id); if (!r) return;
  const e = db.estados[id] || { estatus: 'sin_evaluar', nota: '' };
  const tag = s => s === 'por_validar' ? '<span class="tag warn">por validar</span>' : s === 'pendiente' ? '<span class="tag warn">pendiente</span>' : s === 'categoria' ? '<span class="tag">cita a nivel NOM</span>' : '';
  $('#panelBody').innerHTML = `
  <div style="display:flex;justify-content:space-between;gap:1rem"><h2>${esc(r.id)}</h2><button id="pCerrar">Cerrar ✕</button></div>
  <p class="muted">${esc(r.categoria)}${r.subcategoria ? ' · ' + esc(r.subcategoria) : ''}</p>
  <p><b>${esc(r.texto)}</b></p>
  <section><h3>Referencia normativa ${tag(r.refEstado)}</h3>
    <div class="refbox">${esc(refTxt(r)) || 'Sin referencia capturada.'}</div>
    <details><summary class="muted">Editar referencia</summary><div class="row">
      <div><label>NOM</label><input id="rNom" value="${esc(r.ref.nom)}"></div><div><label>Ley</label><input id="rLey" value="${esc(r.ref.ley)}"></div>
      <div><label>Reglamento</label><input id="rReg" value="${esc(r.ref.reglamento)}"></div><div><label>Artículo / numeral</label><input id="rArt" value="${esc(r.ref.articulo)}"></div>
      <button id="rGuardar">Aplicar</button></div></details></section>
  <section><h3>¿Cómo cumplir? ${tag(r.guiaEstado)}</h3>
    <div class="guia">${esc(r.guia) || '<span class="muted">Guía pendiente de redactar.</span>'}</div>
    <details><summary class="muted">Editar guía</summary><textarea id="gTxt">${esc(r.guia)}</textarea><button id="gGuardar">Aplicar</button></details></section>
  <section><h3>Estatus</h3>
    <div class="estatus-btns">${Object.keys(ESTATUS).map(k => `<button data-est="${k}" class="${e.estatus === k ? 'sel' : ''}">${ESTATUS[k].es}</button>`).join('')}</div>
    <label>Nota / observación</label><textarea id="eNota">${esc(e.nota)}</textarea>
    <span class="muted">Última evaluación: ${esc(e.fecha || '—')}</span></section>
  <section><h3>Evidencia</h3>
    ${evDe(id).map(v => `<div class="item"><span>${v.tipo === 'liga' && urlSegura(v.url) ? `<a href="${esc(urlSegura(v.url))}" target="_blank" rel="noopener">${esc(v.nombre)}</a>` : v.tipo === 'archivo' ? `<button class="link" data-file="${esc(v.id)}">${esc(v.nombre)}</button>` : esc(v.nombre)}
      <br><span class="muted">${esc(v.tipo)} · ${esc(v.fecha)}${v.vence ? ' · vence <span class="' + (v.vence < hoy() ? 'vencida' : '') + '">' + esc(v.vence) + '</span>' : ''}${v.desc ? ' · ' + esc(v.desc) : ''}</span></span>
      <button class="danger" data-delev="${esc(v.id)}">Quitar</button></div>`).join('') || '<span class="muted">Sin evidencia registrada.</span>'}
    <div class="row" style="margin-top:.6rem"><div><label>Descripción</label><input id="vDesc"></div><div><label>Vigencia (opcional)</label><input type="date" id="vVence"></div></div>
    <div class="row"><div><label>Liga (Drive, SharePoint…)</label><input id="vUrl" placeholder="https://…"></div><button id="vLiga">Agregar liga</button><button id="vArchivo" class="primary">Adjuntar archivo…</button></div>
    ${dirHandle ? '' : '<p class="muted">Para adjuntar archivos conecta primero la carpeta de datos (Configuración).</p>'}</section>
  <section><h3>Tareas de seguimiento</h3>
    ${db.tareas.filter(t => t.reqId === id).map(t => `<div class="item"><span>${esc(t.titulo)}<br><span class="muted">${esc(t.responsable || 'sin responsable')} · <span class="${t.estado !== 'cerrada' && t.vence && t.vence < hoy() ? 'vencida' : ''}">${esc(t.vence || 'sin fecha')}</span> · ${esc(t.estado)}</span></span>
      <button data-toggle="${esc(t.id)}">${t.estado === 'cerrada' ? 'Reabrir' : 'Cerrar'}</button></div>`).join('') || '<span class="muted">Sin tareas.</span>'}
    <div class="row" style="margin-top:.6rem"><div style="flex:2"><label>Nueva tarea</label><input id="tTit"></div><div><label>Responsable</label><input id="tResp"></div><div><label>Fecha compromiso</label><input type="date" id="tVence"></div><button id="tAdd" class="primary">Agregar</button></div></section>`;
  $('#panel').hidden = false; $('#overlay').hidden = false;
  const b = $('#panelBody'), re = () => { marcar(); render(); abrirPanel(id); };
  const setE = o => { db.estados[id] = Object.assign({ estatus: 'sin_evaluar', nota: '' }, db.estados[id], o, { fecha: hoy() }); };
  $('#pCerrar').onclick = cerrarPanel;
  b.querySelectorAll('[data-est]').forEach(x => x.onclick = () => { setE({ estatus: x.dataset.est, nota: $('#eNota').value }); re(); });
  $('#eNota').onchange = () => { setE({ nota: $('#eNota').value }); marcar(); };
  $('#rGuardar').onclick = () => { (db.ediciones[id] ||= {}).ref = { nom: $('#rNom').value.trim(), ley: $('#rLey').value.trim(), reglamento: $('#rReg').value.trim(), articulo: $('#rArt').value.trim() }; re(); };
  $('#gGuardar').onclick = () => { (db.ediciones[id] ||= {}).guia = $('#gTxt').value.trim(); re(); };
  const base = () => ({ id: uid('E'), reqId: id, fecha: hoy(), vence: $('#vVence').value, desc: $('#vDesc').value.trim() });
  $('#vLiga').onclick = () => { const u = urlSegura($('#vUrl').value.trim()); if (!u) return alert('Escribe una liga que empiece con https://'); db.evidencias.push(Object.assign(base(), { tipo: 'liga', nombre: $('#vDesc').value.trim() || u, url: u })); re(); };
  $('#vArchivo').onclick = () => {
    if (!dirHandle) return alert('Conecta primero la carpeta de datos en Configuración.');
    const meta = base(), fp = $('#filePick'); fp.value = '';
    fp.onchange = async () => { const f = fp.files[0]; if (!f) return;
      const d = await (await dirHandle.getDirectoryHandle('evidencia', { create: true })).getDirectoryHandle(id, { create: true });
      const n = nombreSeguro(f.name); await escribirArchivo(d, n, f);
      db.evidencias.push(Object.assign(meta, { tipo: 'archivo', nombre: n, ruta: `evidencia/${id}/${n}` })); re(); };
    fp.click();
  };
  b.querySelectorAll('[data-file]').forEach(x => x.onclick = async () => { const v = db.evidencias.find(q => q.id === x.dataset.file);
    try { const d = await (await dirHandle.getDirectoryHandle('evidencia')).getDirectoryHandle(v.reqId); const f = await (await d.getFileHandle(v.nombre)).getFile(); window.open(URL.createObjectURL(f), '_blank'); }
    catch { alert('No se encontró el archivo en la carpeta de datos: ' + (v.ruta || v.nombre)); } });
  b.querySelectorAll('[data-delev]').forEach(x => x.onclick = () => { if (!confirm('¿Quitar esta evidencia del registro? (El archivo en la carpeta no se borra.)')) return; db.evidencias = db.evidencias.filter(q => q.id !== x.dataset.delev); re(); });
  b.querySelectorAll('[data-toggle]').forEach(x => x.onclick = () => { const t = db.tareas.find(q => q.id === x.dataset.toggle); t.estado = t.estado === 'cerrada' ? 'abierta' : 'cerrada'; t.cierre = t.estado === 'cerrada' ? hoy() : ''; re(); });
  $('#tAdd').onclick = () => { const ti = $('#tTit').value.trim(); if (!ti) return; db.tareas.push({ id: uid('T'), reqId: id, titulo: ti, responsable: $('#tResp').value.trim(), vence: $('#tVence').value, estado: 'abierta', notas: '' }); re(); };
}
function cerrarPanel() { $('#panel').hidden = true; $('#overlay').hidden = true; }

// ---------- tareas ----------
function vTareas() {
  const hoyS = hoy(), ts = [...db.tareas].sort((a, b) => (a.estado === 'cerrada') - (b.estado === 'cerrada') || (a.vence || '9').localeCompare(b.vence || '9'));
  $('#main').innerHTML = `<h2>Tareas de seguimiento</h2>
  <table><thead><tr><th>Tarea</th><th>Requisito</th><th>Responsable</th><th>Fecha compromiso</th><th>Estado</th></tr></thead><tbody>
  ${ts.map(t => `<tr><td>${esc(t.titulo)}</td><td>${t.reqId ? `<button class="link" data-open="${esc(t.reqId)}">${esc(t.reqId)}</button>` : '—'}</td><td>${esc(t.responsable || '—')}</td>
    <td class="${t.estado !== 'cerrada' && t.vence && t.vence < hoyS ? 'vencida' : ''}">${esc(t.vence || 'sin fecha')}${t.estado !== 'cerrada' && t.vence && t.vence < hoyS ? ' (vencida)' : ''}</td><td>${esc(t.estado)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Sin tareas. Se crean desde el detalle de cada requisito.</td></tr>'}
  </tbody></table>`;
}

// ---------- novedades legales ----------
function vNovedades() {
  const ns = [...novedadesRepo.novedades].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  $('#main').innerHTML = `<h2>Novedades legales</h2>
  <p class="muted">Cambios detectados en la revisión periódica de fuentes oficiales (DOF, STPS, SEMARNAT, Periódico Oficial del estado). Última revisión: ${esc(novedadesRepo.actualizado || 'aún no se ha ejecutado')}. Cada novedad es una propuesta: revísala contra la fuente antes de aceptarla.</p>
  <p><button id="nImp">Importar novedades desde archivo…</button></p>
  <div class="grid">${ns.map(n => { const st = db.novedades[n.id];
    return `<div class="card nov ${esc(n.impacto || '')}"><h3>${esc(n.titulo)} ${st ? `<span class="tag">${esc(st)}</span>` : '<span class="tag warn">nueva</span>'}</h3>
    <p class="muted">${esc(n.fecha || '')} · ${esc(n.fuente || '')}${n.impacto ? ' · impacto ' + esc(n.impacto) : ''}</p><p>${esc(n.resumen || '')}</p>
    ${urlSegura(n.url) ? `<p><a href="${esc(urlSegura(n.url))}" target="_blank" rel="noopener">Ver fuente oficial</a></p>` : ''}
    ${(n.requisitos || []).length ? `<p class="muted">Propone ${n.requisitos.length} requisito(s) nuevo(s): ${n.requisitos.map(r => esc(r.texto.slice(0, 80))).join(' · ')}</p>` : ''}
    <div class="row"><button class="primary" data-nacep="${esc(n.id)}">${(n.requisitos || []).length ? 'Aceptar y agregar requisitos' : 'Marcar como revisada'}</button><button data-ntarea="${esc(n.id)}">Crear tarea</button><button data-ndesc="${esc(n.id)}">Descartar</button></div></div>`; }).join('') || '<div class="card muted">No hay novedades registradas.</div>'}</div>`;
  const m = $('#main'), busca = id => novedadesRepo.novedades.find(n => n.id === id);
  m.querySelectorAll('[data-nacep]').forEach(b => b.onclick = () => { const n = busca(b.dataset.nacep);
    for (const r of n.requisitos || []) if (!reqs().some(x => x.id === r.id)) db.reqsPropios.push(Object.assign({ ref: {}, guia: '', guiaEstado: 'por_validar', refEstado: 'por_validar', categoria: 'Novedades', modulo: 'otros' }, r));
    db.novedades[n.id] = 'aceptada'; marcar(); render(); });
  m.querySelectorAll('[data-ndesc]').forEach(b => b.onclick = () => { db.novedades[b.dataset.ndesc] = 'descartada'; marcar(); render(); });
  m.querySelectorAll('[data-ntarea]').forEach(b => b.onclick = () => { const n = busca(b.dataset.ntarea); db.tareas.push({ id: uid('T'), reqId: '', titulo: 'Evaluar novedad legal: ' + n.titulo, responsable: '', vence: '', estado: 'abierta', notas: n.url || '' }); marcar(); render(); alert('Tarea creada.'); });
  $('#nImp').onclick = () => elegirArchivo(async f => { const d = JSON.parse(await f.text()); const ids = new Set(novedadesRepo.novedades.map(n => n.id));
    for (const n of d.novedades || []) if (!ids.has(n.id)) novedadesRepo.novedades.push(n); novedadesRepo.actualizado = d.actualizado || novedadesRepo.actualizado; render(); });
}
function elegirArchivo(cb) { const fp = $('#filePick'); fp.value = ''; fp.onchange = () => fp.files[0] && cb(fp.files[0]).catch(e => alert('No se pudo leer el archivo: ' + e.message)); fp.click(); }

// ---------- configuración ----------
function vConfig() {
  const e = db.empresa;
  $('#main').innerHTML = `<div class="grid cols2">
  <div class="card"><h2>Carpeta de datos</h2>
    <p>${dirHandle ? `Conectada: <b>${esc(dirHandle.name)}</b>. Ahí se guardan <code>datos.json</code> y la subcarpeta <code>evidencia/</code>.` : 'Sin carpeta: los datos se guardan solo en este navegador y no se pueden adjuntar archivos.'}</p>
    <p class="muted">${FS_OK ? 'Elige una carpeta de la red local para que otras personas abran los mismos datos. Solo una persona debe editar a la vez; al guardar se avisa si alguien más guardó antes.' : 'Este navegador no permite conectar carpetas. Usa Chrome o Edge en PC.'}</p>
    <div class="row"><button id="cCarpeta" class="primary">${dirHandle ? 'Cambiar carpeta…' : 'Elegir carpeta…'}</button></div>
    <label>Tu nombre (se registra al guardar)</label><input id="cUsuario" value="${esc(localStorage.getItem('usuario') || '')}"></div>
  <div class="card"><h2>Respaldo y traslado</h2>
    <p class="muted">El respaldo es un ZIP con los datos y todos los archivos de evidencia. Para cambiar de PC: descarga el respaldo, abre la app en la otra PC, conecta una carpeta y restaura.</p>
    <div class="row"><button id="cResp" class="primary">Descargar respaldo (ZIP)</button><button id="cRest">Restaurar / importar datos…</button></div></div>
  <div class="card"><h2>Empresa</h2>
    <div class="row"><div><label>Nombre</label><input id="eNom" value="${esc(e.nombre)}"></div><div><label>Estado</label><input id="eEdo" value="${esc(e.estado)}"></div><div><label>Municipio</label><input id="eMun" value="${esc(e.municipio)}"></div></div>
    <h3 style="margin-top:1rem">Perfil de aplicabilidad</h3>
    <p class="muted">Al aplicar el perfil, los requisitos condicionados a una respuesta "No" se marcan como No aplica (solo si están sin evaluar o ya eran No aplica por perfil).</p>
    ${PERFIL.map(([k, q]) => `<label style="color:inherit"><select data-perfil="${k}"><option value="">—</option><option value="si" ${e.perfil[k] === 'si' ? 'selected' : ''}>Sí</option><option value="no" ${e.perfil[k] === 'no' ? 'selected' : ''}>No</option></select> ${esc(q)}</label>`).join('')}
    <div class="row" style="margin-top:.6rem"><button id="eAplicar" class="primary">Guardar empresa y aplicar perfil</button></div></div>
  <div class="card"><h2>Agregar requisito propio</h2>
    <p class="muted">Para requisitos nuevos, condicionantes de permisos o requisitos de cliente/corporativo.</p>
    <div class="row"><div><label>Módulo</label><input id="nMod" list="mods" placeholder="stps, ambiental, proteccion_civil…"><datalist id="mods">${modulos().map(m => `<option value="${esc(m.id)}">`).join('')}</datalist></div><div><label>Categoría</label><input id="nCat"></div></div>
    <label>Requisito</label><textarea id="nTxt"></textarea>
    <div class="row"><div><label>NOM / Ley</label><input id="nNom"></div><div><label>Artículo / numeral</label><input id="nArt"></div></div>
    <label>¿Cómo cumplir?</label><textarea id="nGuia"></textarea>
    <button id="nAdd" class="primary">Agregar requisito</button>
    <p class="muted">Catálogo cargado: ${catalogos.map(m => `${esc(m.nombre)} (${m.requisitos.length}, v${esc(m.version || '')})`).join(' · ')} · propios: ${db.reqsPropios.length}</p></div>
  </div>`;
  $('#cCarpeta').onclick = elegirCarpeta;
  $('#cUsuario').onchange = ev => localStorage.setItem('usuario', ev.target.value.trim());
  $('#cResp').onclick = () => respaldo().catch(er => alert('No se pudo generar el respaldo: ' + er.message));
  $('#cRest').onclick = () => elegirArchivo(restaurar);
  $('#eAplicar').onclick = () => {
    e.nombre = $('#eNom').value.trim(); e.estado = $('#eEdo').value.trim(); e.municipio = $('#eMun').value.trim();
    document.querySelectorAll('[data-perfil]').forEach(s => e.perfil[s.dataset.perfil] = s.value);
    let n = 0;
    for (const r of reqs()) { if (!r.condicion) continue; const resp = e.perfil[r.condicion], s = db.estados[r.id] || {};
      if (resp === 'no' && (!s.estatus || s.estatus === 'sin_evaluar')) { db.estados[r.id] = { estatus: 'na', nota: 'No aplica según perfil de la empresa', fecha: hoy(), porPerfil: true }; n++; }
      else if (resp === 'si' && s.porPerfil) { db.estados[r.id] = { estatus: 'sin_evaluar', nota: '', fecha: hoy() }; n++; } }
    marcar(); render(); alert(`Perfil aplicado. ${n} requisito(s) actualizados.`);
  };
  $('#nAdd').onclick = () => { const txt = $('#nTxt').value.trim(), mod = $('#nMod').value.trim() || 'otros'; if (!txt) return alert('Escribe el requisito.');
    db.reqsPropios.push({ id: 'PROP-' + String(db.reqsPropios.length + 1).padStart(3, '0') + '-' + Date.now().toString(36).slice(-3), modulo: mod, categoria: $('#nCat').value.trim() || 'Requisitos propios', num: '', texto: txt,
      ref: { nom: $('#nNom').value.trim(), ley: '', reglamento: '', articulo: $('#nArt').value.trim() }, refEstado: 'usuario', guia: $('#nGuia').value.trim(), guiaEstado: 'usuario' });
    marcar(); render(); alert('Requisito agregado.'); };
}

// ---------- arranque ----------
document.addEventListener('click', ev => {
  const o = ev.target.closest('[data-open]'); if (o) { abrirPanel(o.dataset.open); return; }
  const v = ev.target.closest('#nav [data-view]'); if (v) { vista = v.dataset.view; cerrarPanel(); render(); }
});
$('#overlay').onclick = cerrarPanel;
$('#btnSave').onclick = () => guardar().catch(e => alert('No se pudo guardar: ' + e.message));
$('#btnLang').onclick = () => { lang = lang === 'es' ? 'en' : 'es'; $('#btnLang').textContent = lang === 'es' ? 'EN' : 'ES'; render(); };
window.addEventListener('beforeunload', e => { if (sucio) { e.preventDefault(); e.returnValue = ''; } });

(async function init() {
  try {
    const idx = await (await fetch('catalogo/index.json', { cache: 'no-store' })).json();
    catalogos = await Promise.all(idx.catalogos.map(async f => (await fetch('catalogo/' + f, { cache: 'no-store' })).json()));
    novedadesRepo = await (await fetch('catalogo/novedades.json', { cache: 'no-store' })).json().catch(() => novedadesRepo);
  } catch (e) { banner('No se pudo cargar el catálogo. La app debe abrirse desde GitHub Pages o un servidor local, no con doble clic al archivo. (' + esc(e.message) + ')'); }
  const local = localStorage.getItem('cumplimiento_db');
  if (local) try { db = normalizar(JSON.parse(local)); } catch { }
  const ok = FS_OK ? await reconectar().catch(() => false) : false;
  if (!ok && !$('#banner').innerHTML && !local) banner('Primera vez: ve a <b>Configuración</b> para elegir la carpeta de datos y, si ya tienes un archivo de datos iniciales, restáuralo ahí.');
  render();
})();
