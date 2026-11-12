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

let lang = localStorage.getItem('lang') || 'es';
const L = (es, en) => lang === 'en' ? en : es;   // texto de interfaz en el idioma activo

const ESTATUS = {
  cumple: { es: 'Cumple', en: 'Compliant' },
  proceso: { es: 'En proceso', en: 'In progress' },
  no_cumple: { es: 'No cumple', en: 'Non-compliant' },
  na: { es: 'No aplica', en: 'N/A' },
  sin_evaluar: { es: 'Sin evaluar', en: 'Not assessed' }
};
const eN = k => ESTATUS[k][lang];
const T_EST = { abierta: ['Abierta', 'Open'], en_proceso: ['En proceso', 'In progress'], cerrada: ['Cerrada', 'Closed'] };
const tN = k => (T_EST[k] || T_EST.abierta)[lang === 'en' ? 1 : 0];
const PERFIL = [
  ['subcontratacion', '¿Contrata servicios especializados (subcontratación)?', 'Does the company hire specialized services (subcontracting)?'],
  ['sustancias_quimicas', '¿Maneja, transporta o almacena sustancias químicas peligrosas?', 'Does it handle, transport or store hazardous chemicals?'],
  ['trabajos_altura', '¿Se realizan trabajos en altura?', 'Is work at height performed?'],
  ['recipientes_presion', '¿Tiene recipientes sujetos a presión, criogénicos o calderas?', 'Does it have pressure vessels, cryogenic vessels or boilers?'],
  ['electricidad_estatica', '¿Hay áreas con riesgo por electricidad estática?', 'Are there areas with static electricity risk?'],
  ['fuentes_fijas', '¿Tiene fuentes fijas de emisiones a la atmósfera (chimeneas, calderas, hornos)?', 'Does it have stationary air emission sources (stacks, boilers, furnaces)?'],
  ['suelo_contaminado', '¿Existe o ha existido contaminación de suelo / pasivos ambientales?', 'Is there, or has there been, soil contamination / environmental liabilities?']
];

// ---------- estado ----------
let catalogos = [];
let novedadesRepo = { actualizado: '', novedades: [] };
let db = dbVacia();
let dirHandle = null;
let cargadoTs = null;
let sucio = false;
let vista = 'dashboard';
let filtros = { modulo: '', estatus: '', q: '', sinEv: false, porVal: false };
const FS_OK = 'showDirectoryPicker' in window;

function dbVacia() {
  return { version: 2, empresa: { nombre: '', estado: '', municipio: '', perfil: {} }, estados: {}, evidencias: [], tareas: [],
    historial: {}, novedades: {}, reqsPropios: [], ediciones: {}, meta: { ts: null, usuario: '' } };
}
function normalizar(d) {
  const n = Object.assign(dbVacia(), d, { empresa: Object.assign(dbVacia().empresa, d.empresa || {}) });
  // las tareas importadas automáticamente de la matriz ya no se usan: las tareas las captura el usuario
  n.tareas = (n.tareas || []).filter(t => t.notas !== 'Acción importada de la matriz ambiental');
  return n;
}
function reqs() {
  const out = [];
  for (const m of catalogos) for (const r of m.requisitos) out.push(aplicarEd(r));
  for (const r of db.reqsPropios) out.push(aplicarEd(r));
  return out;
}
function aplicarEd(r) {
  const e = db.ediciones[r.id];
  if (!e) return r;
  return Object.assign({}, r, e.ref ? { ref: Object.assign({}, r.ref, e.ref), refEstado: 'validada' } : {}, { textoLegal: e.textoLegal || r.textoLegal || '' });
}
const modulos = () => {
  const ms = catalogos.map(m => ({ id: m.id, nombre: m.nombre, nombre_en: m.nombre_en || m.nombre }));
  for (const r of db.reqsPropios) if (!ms.some(m => m.id === r.modulo)) ms.push({ id: r.modulo, nombre: r.modulo, nombre_en: r.modulo });
  return ms;
};
const mN = m => lang === 'en' ? m.nombre_en : m.nombre;
const est = id => (db.estados[id] && db.estados[id].estatus) || 'sin_evaluar';
const evDe = id => db.evidencias.filter(e => e.reqId === id);
const refTxt = r => [r.ref.nom, r.ref.ley, r.ref.reglamento, r.ref.articulo && ('Art./numeral ' + r.ref.articulo)].filter(Boolean).join(' · ');
const POR_VALIDAR = ['por_validar', 'pendiente', 'categoria', 'guia'];
const vencida = t => t.estado !== 'cerrada' && t.vence && t.vence < hoy();

function resumen(lista) {
  const c = { cumple: 0, proceso: 0, no_cumple: 0, na: 0, sin_evaluar: 0 };
  for (const r of lista) c[est(r.id)]++;
  const apl = lista.length - c.na;
  return Object.assign(c, { apl, pct: apl ? (c.cumple + 0.5 * c.proceso) / apl : null, pctE: apl ? c.cumple / apl : null });
}
const fpct = p => p == null ? '—' : Math.round(p * 100) + '%';
const fpct2 = p => p == null ? '—' : (p * 100).toFixed(2) + ' %';
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
async function subcarpeta(ruta, crear) { // ruta: ['evidencia', 'STPS-001']
  let d = dirHandle; for (const p of ruta) d = await d.getDirectoryHandle(p, { create: !!crear }); return d;
}
async function elegirCarpeta() {
  if (!FS_OK) return alert(L('Este navegador no permite trabajar con carpetas. Usa Chrome o Edge en PC, o usa Respaldo/Restaurar.', 'This browser cannot work with folders. Use Chrome or Edge on a PC, or use Backup/Restore.'));
  try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
  await idb.set('dir', dirHandle);
  await cargarDeCarpeta();
}
async function reconectar() {
  const h = await idb.get('dir').catch(() => null);
  if (!h) return false;
  if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    banner(`${L('Carpeta de datos recordada', 'Remembered data folder')}: <b>${esc(h.name)}</b>. <button id="bReconectar">${L('Reconectar', 'Reconnect')}</button>`);
    $('#bReconectar').onclick = async () => { if ((await h.requestPermission({ mode: 'readwrite' })) === 'granted') { dirHandle = h; banner(''); await cargarDeCarpeta(); } };
    return false;
  }
  dirHandle = h; await cargarDeCarpeta(); return true;
}
async function cargarDeCarpeta() {
  const txt = await leerArchivo(dirHandle, 'datos.json');
  if (txt) { db = normalizar(JSON.parse(txt)); cargadoTs = db.meta.ts; }
  else { cargadoTs = null; if (!confirm(L('La carpeta no tiene datos.json. ¿Usar aquí los datos que tienes abiertos ahora?\n(Cancelar = empezar en blanco en esta carpeta)', 'This folder has no datos.json. Use the data you currently have open here?\n(Cancel = start blank in this folder)'))) db = dbVacia(); }
  sucio = !txt; render();
}
async function guardar() {
  db.meta.usuario = localStorage.getItem('usuario') || db.meta.usuario || '';
  foto();
  if (dirHandle) {
    const actual = await leerArchivo(dirHandle, 'datos.json');
    if (actual) {
      const m = (JSON.parse(actual).meta) || {};
      if (m.ts && m.ts !== cargadoTs && !confirm(L(`Otra persona (${m.usuario || 'desconocido'}) guardó cambios el ${new Date(m.ts).toLocaleString()} después de que abriste los datos.\n\nAceptar = sobrescribir con tu versión.\nCancelar = no guardar (recarga la página para ver sus cambios).`,
        `Someone else (${m.usuario || 'unknown'}) saved changes on ${new Date(m.ts).toLocaleString()} after you opened the data.\n\nOK = overwrite with your version.\nCancel = do not save (reload the page to see their changes).`))) return;
    }
    db.meta.ts = Date.now(); cargadoTs = db.meta.ts;
    await escribirArchivo(dirHandle, 'datos.json', JSON.stringify(db, null, 1));
  } else {
    db.meta.ts = Date.now();
    try { localStorage.setItem('cumplimiento_db', JSON.stringify(db)); } catch { alert(L('No se pudo guardar en el navegador (espacio lleno). Descarga un respaldo.', 'Could not save in the browser (storage full). Download a backup.')); return; }
  }
  sucio = false; pintarEstado();
}
function foto() {
  const mods = {}; for (const m of modulos()) mods[m.id] = resumen(reqs().filter(r => r.modulo === m.id)).pct;
  db.historial[mesActual()] = { global: resumen(reqs()).pct, modulos: mods };
}
function descargar(nombre, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nombre; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function respaldo() {
  const zip = new JSZip(); zip.file('datos.json', JSON.stringify(db, null, 1));
  async function agrega(dir, ruta) { for await (const [n, h] of dir.entries()) { if (h.kind === 'directory') await agrega(h, ruta + n + '/'); else zip.file(ruta + n, await h.getFile()); } }
  if (dirHandle) { try { await agrega(await dirHandle.getDirectoryHandle('evidencia'), 'evidencia/'); } catch { } }
  descargar(`respaldo_cumplimiento_${hoy()}.zip`, await zip.generateAsync({ type: 'blob' }));
}
async function restaurar(file) {
  if (Object.keys(db.estados).length && !confirm(L('Ya hay datos abiertos. ¿Reemplazarlos con los del archivo?', 'Data is already open. Replace it with the file contents?'))) return;
  let datos;
  if (/\.json$/i.test(file.name)) datos = JSON.parse(await file.text());
  else {
    const zip = await JSZip.loadAsync(file); const f = zip.file('datos.json');
    if (!f) return alert(L('El ZIP no contiene datos.json', 'The ZIP does not contain datos.json'));
    datos = JSON.parse(await f.async('string'));
    const archivos = Object.keys(zip.files).filter(p => p.startsWith('evidencia/') && !zip.files[p].dir);
    if (dirHandle) for (const p of archivos) { const partes = p.split('/'); const n = partes.pop(); await escribirArchivo(await subcarpeta(partes, true), n, await zip.files[p].async('blob')); }
    else if (archivos.length) alert(L('Se restauraron los datos. Para restaurar también los archivos de evidencia, primero conecta una carpeta y vuelve a restaurar.', 'Data restored. To also restore evidence files, connect a folder first and restore again.'));
  }
  db = normalizar(datos); marcar(); render();
}
function exportarCSV() {
  const f = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const filas = [[L('ID', 'ID'), L('Módulo', 'Module'), L('Categoría', 'Category'), L('Requisito', 'Requirement'), L('Referencia normativa', 'Legal reference'), L('Texto citado', 'Quoted text'), L('Estatus', 'Status'), L('Nota', 'Note'), L('Evidencias', 'Evidence'), L('Tareas abiertas', 'Open tasks')]];
  for (const r of reqs()) filas.push([r.id, r.modulo, r.categoria, r.texto, refTxt(r), r.textoLegal || '', eN(est(r.id)), (db.estados[r.id] || {}).nota || '',
    evDe(r.id).map(e => e.nombre).join(' | '), db.tareas.filter(t => t.reqId === r.id && t.estado !== 'cerrada').map(t => t.titulo).join(' | ')]);
  descargar(`matriz_cumplimiento_${hoy()}.csv`, new Blob(['﻿' + filas.map(x => x.map(f).join(',')).join('\r\n')], { type: 'text/csv' }));
}

// ---------- interfaz general ----------
function banner(html) { const b = $('#banner'); b.hidden = !html; b.innerHTML = html; }
function pintarEstado() {
  $('#saveState').textContent = (dirHandle ? '📁 ' + dirHandle.name : L('Sin carpeta (navegador)', 'No folder (browser)')) + (sucio ? L(' · cambios sin guardar', ' · unsaved changes') : L(' · guardado', ' · saved'));
  $('#empresaNombre').textContent = db.empresa.nombre || '';
  const tv = db.tareas.filter(vencida).length;
  $('#badgeTareas').hidden = !tv; $('#badgeTareas').textContent = tv;
  const np = novedadesRepo.novedades.filter(n => !db.novedades[n.id]).length;
  $('#badgeNov').hidden = !np; $('#badgeNov').textContent = np;
}
function render() {
  document.documentElement.lang = lang;
  $('#appTitle').textContent = L('Cumplimiento Legal EHS', 'EHS Legal Compliance');
  const nav = { dashboard: L('Tablero', 'Dashboard'), requisitos: L('Requisitos', 'Requirements'), tareas: L('Tareas', 'Tasks'), novedades: L('Novedades', 'Legal updates'), config: L('Configuración', 'Settings') };
  document.querySelectorAll('#nav button').forEach(b => { b.classList.toggle('active', b.dataset.view === vista); b.querySelector('.lbl').textContent = nav[b.dataset.view]; });
  $('#btnSave').textContent = L('Guardar', 'Save'); $('#btnLang').textContent = lang === 'es' ? 'EN' : 'ES';
  ({ dashboard: vDashboard, requisitos: vRequisitos, tareas: vTareas, novedades: vNovedades, config: vConfig }[vista])();
  pintarEstado();
}

// ---------- tablero ----------
function vDashboard() {
  const all = reqs(), g = resumen(all), hoyS = hoy();
  const en60 = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10);
  const sinEv = all.filter(r => est(r.id) === 'cumple' && !evDe(r.id).length).length;
  const tv = db.tareas.filter(vencida);
  const ev = db.evidencias.filter(e => e.vence && e.vence <= en60);
  const kpi = (n, l, alerta) => `<div class="card kpi ${alerta ? 'alerta' : ''}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
  const barras = lista => [...new Set(lista.map(r => r.categoria))].map(c => { const s = resumen(lista.filter(r => r.categoria === c)); const w = k => s.apl ? (s[k] / s.apl * 100) : 0;
    return `<div class="bar-row"><span class="name" title="${esc(c)}">${esc(c)}</span><span class="bar" role="img" aria-label="${esc(c)}: ${fpct(s.pct)}"><i class="c" style="width:${w('cumple')}%"></i><i class="p" style="width:${w('proceso')}%"></i><i class="n" style="width:${w('no_cumple')}%"></i><i class="s" style="width:${w('sin_evaluar')}%"></i></span><span class="pct">${fpct(s.pct)}</span></div>`; }).join('');
  const leyenda = `<div class="legend"><span style="--k:var(--ok)">${eN('cumple')}</span><span style="--k:var(--proc)">${eN('proceso')}</span><span style="--k:var(--no)">${eN('no_cumple')}</span><span style="--k:#aab2be">${eN('sin_evaluar')}</span></div>`;
  const criticos = all.filter(r => est(r.id) === 'no_cumple');
  const prox = [...db.tareas.filter(x => x.estado !== 'cerrada' && x.vence).map(x => ({ f: x.vence, txt: x.titulo, id: x.reqId, tipo: L('Tarea', 'Task') })),
    ...ev.map(e => ({ f: e.vence, txt: e.nombre, id: e.reqId, tipo: L('Evidencia', 'Evidence') }))].sort((a, b) => a.f.localeCompare(b.f)).slice(0, 12);
  const sinDatos = L('Sin datos todavía', 'No data yet');
  $('#main').innerHTML = `
  <div class="grid kpis">
    ${kpi(fpct(g.pct), L('Cumplimiento global', 'Overall compliance'))}
    ${modulos().map(m => kpi(fpct(resumen(all.filter(r => r.modulo === m.id)).pct), esc(mN(m)))).join('')}
    ${kpi(g.apl, L('Requisitos aplicables', 'Applicable requirements'))}${kpi(g.no_cumple, L('No cumplen', 'Non-compliant'), g.no_cumple)}${kpi(g.proceso, L('En proceso', 'In progress'))}
    ${kpi(sinEv, L('Cumple sin evidencia', 'Compliant w/o evidence'), sinEv)}${kpi(tv.length, L('Tareas vencidas', 'Overdue tasks'), tv.length)}${kpi(ev.length, L('Evidencia por vencer (60 días)', 'Evidence expiring (60 days)'), ev.length)}
  </div>
  <p class="noprint row" style="margin:.8rem 0;justify-content:flex-start"><button id="bInforme" class="primary">${L('Descargar informe de cumplimiento (Word)', 'Download compliance report (Word)')}</button><button onclick="print()">${L('Imprimir tablero', 'Print dashboard')}</button></p>
  <div class="grid cols2">
    ${modulos().map(m => `<div class="card"><h2>${L('Cumplimiento por categoría', 'Compliance by category')} — ${esc(mN(m))}</h2>${leyenda}${barras(all.filter(r => r.modulo === m.id)) || sinDatos}</div>`).join('')}
    <div class="card"><h2>${L('Tendencia mensual', 'Monthly trend')}</h2>${tendencia()}</div>
    <div class="card"><h2>${L('Próximos vencimientos', 'Upcoming due dates')}</h2>${prox.length ? prox.map(p => `<div class="item"><span><span class="${p.f < hoyS ? 'vencida' : ''}">${p.f}</span> · ${p.tipo}: ${esc(p.txt)}</span>${p.id ? `<button class="link" data-open="${esc(p.id)}">${esc(p.id)}</button>` : ''}</div>`).join('') : `<span class="muted">${sinDatos}</span>`}</div>
    <div class="card"><h2>${L('Puntos que no cumplen', 'Non-compliant items')}</h2>${criticos.length ? criticos.map(r => `<div class="item"><span>${esc(r.texto.slice(0, 140))}</span><button class="link" data-open="${esc(r.id)}">${esc(r.id)}</button></div>`).join('') : `<span class="muted">—</span>`}</div>
  </div>`;
  $('#bInforme').onclick = informe;
}
function tendencia() {
  const meses = Object.keys(db.historial).sort().slice(-12);
  if (!meses.length) return `<span class="muted">${L('Sin datos todavía. Se registra una foto del mes cada vez que guardas.', 'No data yet. A monthly snapshot is recorded every time you save.')}</span>`;
  const W = 520, H = 190, px = 36, py = 18, x = i => px + (meses.length === 1 ? (W - 2 * px) / 2 : i * (W - 2 * px) / (meses.length - 1)), y = v => H - 26 - v * (H - 26 - py);
  const series = [{ k: 'global', n: 'Global', c: '#1c2430', d: '' }, ...modulos().map((m, i) => ({ k: m.id, n: mN(m), c: ['#28508E', '#901812', '#1f7a4d', '#b26a00'][i % 4], d: i % 2 ? '5 3' : '' }))];
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${L('Tendencia mensual', 'Monthly trend')}">`;
  for (const v of [0, .5, 1]) s += `<line x1="${px}" x2="${W - px}" y1="${y(v)}" y2="${y(v)}" stroke="#d9dee5"/><text x="4" y="${y(v) + 4}">${v * 100}%</text>`;
  meses.forEach((m, i) => s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${m.slice(2)}</text>`);
  for (const se of series) {
    const pts = meses.map((m, i) => { const h = db.historial[m], v = se.k === 'global' ? h.global : (h.modulos || {})[se.k]; return v == null ? null : [x(i), y(v), v]; }).filter(Boolean);
    if (!pts.length) continue;
    s += `<polyline fill="none" stroke="${se.c}" stroke-width="2" stroke-dasharray="${se.d}" points="${pts.map(p => p[0] + ',' + p[1]).join(' ')}"/>`;
    pts.forEach(p => s += `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${se.c}"><title>${esc(se.n)}: ${fpct(p[2])}</title></circle>`);
  }
  return s + '</svg><div class="legend">' + series.map(se => `<span style="--k:${se.c}">${esc(se.n)}</span>`).join('') + '</div>';
}

// ---------- informe de cumplimiento (Word) ----------
function informe() {
  const all = reqs(), g = resumen(all), e = db.empresa, hoyS = hoy();
  const td = (v, a) => `<td style="border:1px solid #999;padding:4px 6px;${a || ''}">${v}</td>`;
  const th = v => `<th style="border:1px solid #999;padding:4px 6px;background:#28508E;color:#fff;text-align:left">${v}</th>`;
  const tabla = (cab, filas) => `<table style="border-collapse:collapse;width:100%;font-size:10pt">${cab ? '<tr>' + cab.map(th).join('') + '</tr>' : ''}${filas.map(f => '<tr>' + f.map(c => td(c)).join('') + '</tr>').join('')}</table>`;
  const cabR = [L('Alcance', 'Scope'), L('Aplicables', 'Applicable'), eN('cumple'), eN('proceso'), eN('no_cumple'), eN('sin_evaluar'), eN('na'), L('% ponderado', 'Weighted %'), L('% estricto', 'Strict %')];
  const filaR = (n, s) => [esc(n), s.apl, s.cumple, s.proceso, s.no_cumple, s.sin_evaluar, s.na, fpct2(s.pct), fpct2(s.pctE)];
  const tareasDe = id => db.tareas.filter(t => t.reqId === id);
  const hallazgo = (r, i) => { const s = db.estados[r.id] || {}, ts = tareasDe(r.id);
    return `<h3>${L('Hallazgo', 'Finding')} ${i + 1} – ${esc(r.id)}</h3>
    <p><b>${L('Requisito', 'Requirement')}:</b> ${esc(r.texto)}</p>
    <p><b>${L('Referencia normativa', 'Legal reference')}:</b> ${esc(refTxt(r)) || '—'}${POR_VALIDAR.includes(r.refEstado) ? ` <i>(${L('cita por validar', 'citation pending validation')})</i>` : ''}</p>
    ${r.textoLegal ? `<p style="margin-left:18pt;border-left:3px solid #28508E;padding-left:8pt"><i>${esc(r.textoLegal)}</i></p>` : ''}
    <p><b>${L('Situación registrada', 'Recorded situation')}:</b> ${esc(s.nota) || L('Sin observación capturada.', 'No observation recorded.')} (${L('última evaluación', 'last assessed')}: ${esc(s.fecha || '—')})</p>
    <p><b>${L('Evidencia registrada', 'Evidence on file')}:</b> ${evDe(r.id).map(v => esc(v.nombre)).join('; ') || L('Ninguna', 'None')}</p>
    <p><b>${L('Acciones', 'Actions')}:</b> ${ts.length ? ts.map(t => `${esc(t.titulo)} — ${esc(t.responsable || L('sin responsable', 'no owner'))}, ${esc(t.vence || L('sin fecha', 'no date'))} (${tN(t.estado)})`).join('; ') : L('Sin tarea asignada.', 'No task assigned.')}</p>`; };
  const nc = all.filter(r => est(r.id) === 'no_cumple'), pr = all.filter(r => est(r.id) === 'proceso');
  const abiertas = db.tareas.filter(t => t.estado !== 'cerrada').sort((a, b) => (a.vence || '9').localeCompare(b.vence || '9'));
  const en60 = new Date(Date.now() + 60 * 864e5).toISOString().slice(0, 10), evv = db.evidencias.filter(v => v.vence && v.vence <= en60);
  const sinEv = all.filter(r => est(r.id) === 'cumple' && !evDe(r.id).length);
  const novPend = novedadesRepo.novedades.filter(n => !db.novedades[n.id]);
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${L('Informe de cumplimiento', 'Compliance report')}</title>
  <style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#1c2430} h1{color:#901812;font-size:20pt;margin-bottom:2pt} h2{color:#28508E;font-size:14pt;margin-top:18pt;border-bottom:1px solid #28508E} h3{font-size:11.5pt;margin-top:12pt;color:#28508E} .nota{background:#f3f6fb;padding:6pt;font-size:10pt}</style></head><body>
  <h1>${L('Informe de Cumplimiento Legal EHS', 'EHS Legal Compliance Report')}</h1>
  <p><b>${L('Empresa', 'Company')}:</b> ${esc(e.nombre || '—')}<br><b>${L('Sitio', 'Site')}:</b> ${esc([e.municipio, e.estado].filter(Boolean).join(', ') || '—')}<br>
  <b>${L('Fecha del informe', 'Report date')}:</b> ${hoyS}<br><b>${L('Elaboró', 'Prepared by')}:</b> ${esc(localStorage.getItem('usuario') || db.meta.usuario || '—')}<br>
  <b>${L('Alcance', 'Scope')}:</b> ${modulos().map(m => esc(mN(m))).join(' · ')}</p>
  <p class="nota">${L('Este informe describe el estatus registrado en el gestor de cumplimiento a la fecha indicada. No constituye una certificación de conformidad, una resolución de autoridad ni una verificación física de todas las condiciones del centro de trabajo. Los hallazgos son recomendaciones internas de gestión.',
    'This report describes the status recorded in the compliance manager as of the date shown. It is not a conformity certification, an authority resolution, or a physical verification of all workplace conditions. Findings are internal management recommendations.')}</p>
  <h2>1. ${L('Resumen consolidado', 'Consolidated snapshot')}</h2>
  ${tabla(cabR, [...modulos().map(m => filaR(mN(m), resumen(all.filter(r => r.modulo === m.id)))), filaR('GLOBAL', g).map(c => `<b>${c}</b>`)])}
  <p class="nota">${L('% ponderado = (Cumple + 0.5 × En proceso) ÷ aplicables. % estricto = Cumple ÷ aplicables (En proceso no recibe crédito). «No aplica» se excluye del denominador; «Sin evaluar» cuenta como cero.',
    'Weighted % = (Compliant + 0.5 × In progress) ÷ applicable. Strict % = Compliant ÷ applicable (In progress receives no credit). “N/A” is excluded from the denominator; “Not assessed” counts as zero.')}</p>
  <h2>2. ${L('Resultados por categoría', 'Results by category')}</h2>
  ${modulos().map(m => { const lm = all.filter(r => r.modulo === m.id); return `<h3>${esc(mN(m))}</h3>` + tabla([L('Categoría', 'Category'), ...cabR.slice(1)], [...new Set(lm.map(r => r.categoria))].map(c => filaR(c, resumen(lm.filter(r => r.categoria === c))))); }).join('')}
  <h2>3. ${L('Hallazgos prioritarios (No cumple)', 'Priority findings (Non-compliant)')} – ${nc.length}</h2>
  ${nc.map(hallazgo).join('') || `<p>${L('No hay requisitos registrados como No cumple.', 'No requirements are recorded as Non-compliant.')}</p>`}
  <h2>4. ${L('Requisitos en proceso', 'Requirements in progress')} – ${pr.length}</h2>
  ${pr.length ? tabla(['ID', L('Requisito', 'Requirement'), L('Referencia', 'Reference'), L('Observación', 'Observation'), L('Tareas abiertas', 'Open tasks')], pr.map(r => [esc(r.id), esc(r.texto), esc(refTxt(r)), esc((db.estados[r.id] || {}).nota || ''), tareasDe(r.id).filter(t => t.estado !== 'cerrada').length])) : '<p>—</p>'}
  <h2>5. ${L('Plan de acción (tareas abiertas)', 'Action plan (open tasks)')} – ${abiertas.length}</h2>
  ${abiertas.length ? tabla([L('Tarea', 'Task'), L('Requisito', 'Requirement'), L('Acciones', 'Actions'), L('Responsable', 'Owner'), L('Fecha compromiso', 'Due date'), L('Responsable de cierre', 'Closure owner'), L('Estado', 'Status')],
    abiertas.map(t => [esc(t.titulo), esc(t.reqId || '—'), esc(t.acciones || ''), esc(t.responsable || '—'), esc(t.vence || '—') + (vencida(t) ? ` <b style="color:#b3261e">(${L('vencida', 'overdue')})</b>` : ''), esc(t.responsableCierre || '—'), tN(t.estado)])) : `<p>${L('No hay tareas abiertas registradas.', 'No open tasks recorded.')}</p>`}
  <h2>6. ${L('Evidencia', 'Evidence')}</h2>
  <p>${L('Evidencias registradas', 'Evidence items on file')}: ${db.evidencias.length}. ${L('Requisitos marcados «Cumple» sin evidencia registrada', 'Requirements marked “Compliant” with no evidence on file')}: ${sinEv.length}.</p>
  ${evv.length ? `<h3>${L('Evidencia vencida o por vencer en 60 días', 'Evidence expired or expiring within 60 days')}</h3>` + tabla([L('Requisito', 'Requirement'), L('Evidencia', 'Evidence'), L('Vigencia', 'Valid until')], evv.map(v => [esc(v.reqId), esc(v.nombre), esc(v.vence)])) : ''}
  <h2>7. ${L('Novedades legales pendientes de revisar', 'Legal updates pending review')} – ${novPend.length}</h2>
  ${novPend.length ? tabla([L('Fecha', 'Date'), L('Publicación', 'Publication'), L('Fuente', 'Source')], novPend.slice(0, 40).map(n => [esc(n.fecha || ''), esc(n.titulo), esc(n.fuente || '')])) : `<p>${L('Sin novedades pendientes.', 'No pending updates.')} (${L('última revisión automática', 'last automatic check')}: ${esc(novedadesRepo.actualizado || '—')})</p>`}
  </body></html>`;
  descargar(`${L('Informe_cumplimiento', 'Compliance_report')}_${hoyS}.doc`, new Blob(['﻿' + html], { type: 'application/msword' }));
}

// ---------- requisitos (binder) ----------
function vRequisitos() {
  const f = filtros, q = f.q.toLowerCase();
  const lista = reqs().filter(r => (!f.modulo || r.modulo === f.modulo) && (!f.estatus || est(r.id) === f.estatus) &&
    (!f.sinEv || !evDe(r.id).length) && (!f.porVal || POR_VALIDAR.includes(r.refEstado)) && (!q || (r.texto + ' ' + r.categoria + ' ' + refTxt(r) + ' ' + r.id).toLowerCase().includes(q)));
  let html = `<div class="filters">
    <input type="search" id="fq" placeholder="${L('Buscar requisito, NOM, artículo…', 'Search requirement, NOM, article…')}" value="${esc(f.q)}">
    <select id="fm"><option value="">${L('Todos los módulos', 'All modules')}</option>${modulos().map(m => `<option value="${esc(m.id)}" ${f.modulo === m.id ? 'selected' : ''}>${esc(mN(m))}</option>`).join('')}</select>
    <select id="fe"><option value="">${L('Todos los estatus', 'All statuses')}</option>${Object.keys(ESTATUS).map(k => `<option value="${k}" ${f.estatus === k ? 'selected' : ''}>${eN(k)}</option>`).join('')}</select>
    <label style="margin:0"><input type="checkbox" id="fs" ${f.sinEv ? 'checked' : ''}> ${L('Sin evidencia', 'No evidence')}</label>
    <label style="margin:0"><input type="checkbox" id="fv" ${f.porVal ? 'checked' : ''}> ${L('Cita por validar', 'Citation to validate')}</label>
    <span class="muted">${lista.length} ${L('puntos', 'items')}</span>
    <button id="bCsv">${L('Exportar matriz (CSV)', 'Export matrix (CSV)')}</button>
  </div><table><thead><tr><th style="width:7rem">ID</th><th>${L('Requisito', 'Requirement')}</th><th style="width:22%">${L('Referencia', 'Reference')}</th><th style="width:7.5rem">${L('Estatus', 'Status')}</th><th style="width:5rem">${L('Evid.', 'Evid.')}</th><th style="width:5rem">${L('Tareas', 'Tasks')}</th></tr></thead><tbody>`;
  let cat = null;
  for (const r of lista) {
    const c = r.modulo + '|' + r.categoria;
    if (c !== cat) { cat = c; html += `<tr class="cat"><td colspan="6">${esc(r.categoria)} <span class="tag">${fpct(resumen(lista.filter(x => x.modulo + '|' + x.categoria === c)).pct)}</span></td></tr>`; }
    const e = est(r.id), nt = db.tareas.filter(t => t.reqId === r.id && t.estado !== 'cerrada').length;
    html += `<tr class="req" data-open="${esc(r.id)}"><td>${esc(r.id)}</td><td>${esc(r.texto)}</td><td class="muted">${esc(refTxt(r)) || `<span class="tag warn">${L('sin cita', 'no citation')}</span>`}</td><td><span class="pill ${e}">${eN(e)}</span></td><td>${evDe(r.id).length || '—'}</td><td>${nt || '—'}</td></tr>`;
  }
  $('#main').innerHTML = html + '</tbody></table>';
  const upd = () => { filtros = { q: $('#fq').value, modulo: $('#fm').value, estatus: $('#fe').value, sinEv: $('#fs').checked, porVal: $('#fv').checked }; vRequisitos(); const i = $('#fq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); };
  $('#fq').oninput = upd; $('#fm').onchange = upd; $('#fe').onchange = upd; $('#fs').onchange = upd; $('#fv').onchange = upd; $('#bCsv').onclick = exportarCSV;
}

function mostrarPanel(html) { $('#panelBody').innerHTML = html; $('#panel').hidden = false; $('#overlay').hidden = false; $('#panel').scrollTop = 0; }
function cerrarPanel() { $('#panel').hidden = true; $('#overlay').hidden = true; }
const filaEv = (v, del) => `<div class="item"><span>${v.tipo === 'liga' && urlSegura(v.url) ? `<a href="${esc(urlSegura(v.url))}" target="_blank" rel="noopener">${esc(v.nombre)}</a>` : v.tipo === 'archivo' ? `<button class="link" data-file="${esc(v.ruta || '')}">${esc(v.nombre)}</button>` : esc(v.nombre)}
  <br><span class="muted">${esc(v.tipo)} · ${esc(v.fecha || '')}${v.vence ? ` · ${L('vence', 'expires')} <span class="${v.vence < hoy() ? 'vencida' : ''}">${esc(v.vence)}</span>` : ''}${v.desc ? ' · ' + esc(v.desc) : ''}</span></span>
  <button class="danger" data-${del}="${esc(v.id)}">${L('Quitar', 'Remove')}</button></div>`;
async function abrirArchivo(ruta) {
  try { const p = ruta.split('/'); const n = p.pop(); const f = await (await (await subcarpeta(p)).getFileHandle(n)).getFile(); window.open(URL.createObjectURL(f), '_blank'); }
  catch { alert(L('No se encontró el archivo en la carpeta de datos: ', 'File not found in the data folder: ') + ruta); }
}
function adjuntar(ruta, cb) { // ruta de carpeta: ['evidencia', id]
  if (!dirHandle) return alert(L('Conecta primero la carpeta de datos en Configuración.', 'Connect the data folder in Settings first.'));
  const fp = $('#filePick'); fp.value = '';
  fp.onchange = async () => { const f = fp.files[0]; if (!f) return; const n = nombreSeguro(f.name); await escribirArchivo(await subcarpeta(ruta, true), n, f); cb(n, ruta.join('/') + '/' + n); };
  fp.click();
}

function abrirPanel(id) {
  const r = reqs().find(x => x.id === id); if (!r) return;
  const e = db.estados[id] || { estatus: 'sin_evaluar', nota: '' };
  const tag = s => ({ por_validar: `<span class="tag warn">${L('por validar', 'to validate')}</span>`, categoria: `<span class="tag warn">${L('por validar', 'to validate')}</span>`, pendiente: `<span class="tag warn">${L('pendiente', 'pending')}</span>`,
    guia: `<span class="tag warn">${L('numeral según Guía STPS, por validar', 'clause per STPS guide, to validate')}</span>`, texto: `<span class="tag ok">${L('verificada con texto oficial', 'verified against official text')}</span>`,
    numeral: `<span class="tag ok">${L('numeral verificado en la norma oficial', 'clause verified in the official standard')}</span>`,
    usuario: `<span class="tag">${L('de la matriz original', 'from the original matrix')}</span>` }[s] || `<span class="tag ok">${L('validada', 'validated')}</span>`);
  const enl = Object.assign({}, ...catalogos.map(m => m.enlaces || {}));
  const oficial = urlSegura((r.ref.nom || '').split(';').map(x => enl[x.trim()]).find(Boolean));
  const busca = 'https://www.google.com/search?q=' + encodeURIComponent([r.ref.nom || r.ref.ley || r.ref.reglamento, r.ref.articulo, 'texto vigente DOF'].filter(Boolean).join(' '));
  mostrarPanel(`
  <div style="display:flex;justify-content:space-between;gap:1rem"><h2>${esc(r.id)}</h2><button id="pCerrar">${L('Cerrar', 'Close')} ✕</button></div>
  <p class="muted">${esc(r.categoria)}${r.subcategoria ? ' · ' + esc(r.subcategoria) : ''}</p>
  <p><b>${esc(r.texto)}</b></p>
  <section><h3>${L('Referencia normativa', 'Legal reference')} ${tag(r.refEstado)}</h3>
    <div class="refbox">${esc(refTxt(r)) || L('Sin referencia capturada.', 'No reference recorded.')}</div>
    ${r.textoLegal ? `<blockquote class="cita">${esc(r.textoLegal)}</blockquote>` : `<p class="muted">${L('Texto de la disposición aún no capturado.', 'Text of the provision not captured yet.')}</p>`}
    <p>${oficial ? `<a href="${esc(oficial)}" target="_blank" rel="noopener">${L('Abrir la norma oficial (PDF de la STPS)', 'Open the official standard (STPS PDF)')} ↗</a> · ` : ''}<a href="${esc(busca)}" target="_blank" rel="noopener">${L('Buscar el texto oficial vigente', 'Search the current official text')} ↗</a></p>
    <details><summary class="muted">${L('Editar referencia y texto citado', 'Edit reference and quoted text')}</summary><div class="row">
      <div><label>NOM</label><input id="rNom" value="${esc(r.ref.nom)}"></div><div><label>${L('Ley', 'Law')}</label><input id="rLey" value="${esc(r.ref.ley)}"></div>
      <div><label>${L('Reglamento', 'Regulation')}</label><input id="rReg" value="${esc(r.ref.reglamento)}"></div><div><label>${L('Artículo / numeral', 'Article / clause')}</label><input id="rArt" value="${esc(r.ref.articulo)}"></div></div>
      <label>${L('Texto citado de la ley o norma (pégalo de la fuente oficial)', 'Quoted text of the law or standard (paste from the official source)')}</label><textarea id="rTxt">${esc(r.textoLegal || '')}</textarea>
      <button id="rGuardar">${L('Guardar y marcar validada', 'Save and mark validated')}</button></details></section>
  <section><h3>${L('Estatus', 'Status')}</h3>
    <div class="estatus-btns">${Object.keys(ESTATUS).map(k => `<button data-est="${k}" class="${e.estatus === k ? 'sel' : ''}">${eN(k)}</button>`).join('')}</div>
    <label>${L('Nota / observación', 'Note / observation')}</label><textarea id="eNota">${esc(e.nota)}</textarea>
    <span class="muted">${L('Última evaluación', 'Last assessed')}: ${esc(e.fecha || '—')}</span></section>
  <section><h3>${L('Evidencia', 'Evidence')}</h3>
    ${evDe(id).map(v => filaEv(v, 'delev')).join('') || `<span class="muted">${L('Sin evidencia registrada.', 'No evidence on file.')}</span>`}
    <div class="row" style="margin-top:.6rem"><div><label>${L('Descripción', 'Description')}</label><input id="vDesc"></div><div><label>${L('Vigencia (opcional)', 'Valid until (optional)')}</label><input type="date" id="vVence"></div></div>
    <div class="row"><div><label>${L('Liga (Drive, SharePoint…)', 'Link (Drive, SharePoint…)')}</label><input id="vUrl" placeholder="https://…"></div><button id="vLiga">${L('Agregar liga', 'Add link')}</button><button id="vArchivo" class="primary">${L('Adjuntar archivo…', 'Attach file…')}</button></div>
    ${dirHandle ? '' : `<p class="muted">${L('Para adjuntar archivos conecta primero la carpeta de datos (Configuración).', 'To attach files, connect the data folder first (Settings).')}</p>`}</section>
  <section><h3>${L('Tareas de seguimiento', 'Follow-up tasks')}</h3>
    ${db.tareas.filter(t => t.reqId === id).map(t => `<div class="item"><span>${esc(t.titulo)}<br><span class="muted">${esc(t.responsable || L('sin responsable', 'no owner'))} · <span class="${vencida(t) ? 'vencida' : ''}">${esc(t.vence || L('sin fecha', 'no date'))}</span> · ${tN(t.estado)}</span></span>
      <button data-tarea="${esc(t.id)}">${L('Abrir', 'Open')}</button></div>`).join('') || `<span class="muted">${L('Sin tareas.', 'No tasks.')}</span>`}
    <p><button id="tNueva" class="primary">${L('Nueva tarea para este requisito', 'New task for this requirement')}</button></p></section>`);
  const b = $('#panelBody'), re = () => { marcar(); render(); abrirPanel(id); };
  const setE = o => { db.estados[id] = Object.assign({ estatus: 'sin_evaluar', nota: '' }, db.estados[id], o, { fecha: hoy() }); };
  $('#pCerrar').onclick = cerrarPanel;
  b.querySelectorAll('[data-est]').forEach(x => x.onclick = () => { setE({ estatus: x.dataset.est, nota: $('#eNota').value }); re(); });
  $('#eNota').onchange = () => { setE({ nota: $('#eNota').value }); marcar(); };
  $('#rGuardar').onclick = () => { const ed = (db.ediciones[id] ||= {}); ed.ref = { nom: $('#rNom').value.trim(), ley: $('#rLey').value.trim(), reglamento: $('#rReg').value.trim(), articulo: $('#rArt').value.trim() }; ed.textoLegal = $('#rTxt').value.trim(); re(); };
  const base = () => ({ id: uid('E'), reqId: id, fecha: hoy(), vence: $('#vVence').value, desc: $('#vDesc').value.trim() });
  $('#vLiga').onclick = () => { const u = urlSegura($('#vUrl').value.trim()); if (!u) return alert(L('Escribe una liga que empiece con https://', 'Enter a link starting with https://')); db.evidencias.push(Object.assign(base(), { tipo: 'liga', nombre: $('#vDesc').value.trim() || u, url: u })); re(); };
  $('#vArchivo').onclick = () => { const meta = base(); adjuntar(['evidencia', id], (n, ruta) => { db.evidencias.push(Object.assign(meta, { tipo: 'archivo', nombre: n, ruta })); re(); }); };
  b.querySelectorAll('[data-file]').forEach(x => x.onclick = () => abrirArchivo(x.dataset.file));
  b.querySelectorAll('[data-delev]').forEach(x => x.onclick = () => { if (!confirm(L('¿Quitar esta evidencia del registro? (El archivo en la carpeta no se borra.)', 'Remove this evidence from the record? (The file in the folder is not deleted.)'))) return; db.evidencias = db.evidencias.filter(q => q.id !== x.dataset.delev); re(); });
  b.querySelectorAll('[data-tarea]').forEach(x => x.onclick = () => abrirTarea(x.dataset.tarea));
  $('#tNueva').onclick = () => abrirTarea(null, id);
}

// ---------- tareas ----------
function vTareas() {
  const ts = [...db.tareas].sort((a, b) => (a.estado === 'cerrada') - (b.estado === 'cerrada') || (a.vence || '9').localeCompare(b.vence || '9'));
  $('#main').innerHTML = `<div class="filters"><h2 style="flex:1;margin:0">${L('Tareas de seguimiento', 'Follow-up tasks')}</h2><button id="tNueva" class="primary">${L('Nueva tarea', 'New task')}</button></div>
  <table><thead><tr><th>${L('Tarea', 'Task')}</th><th>${L('Requisito', 'Requirement')}</th><th>${L('Responsable', 'Owner')}</th><th>${L('Inicio', 'Start')}</th><th>${L('Fecha compromiso', 'Due date')}</th><th>${L('Resp. de cierre', 'Closure owner')}</th><th>${L('Evid.', 'Evid.')}</th><th>${L('Estado', 'Status')}</th></tr></thead><tbody>
  ${ts.map(t => `<tr class="req" data-tarea="${esc(t.id)}"><td>${esc(t.titulo)}</td><td>${esc(t.reqId || '—')}</td><td>${esc(t.responsable || '—')}</td><td>${esc(t.inicio || '—')}</td>
    <td class="${vencida(t) ? 'vencida' : ''}">${esc(t.vence || L('sin fecha', 'no date'))}${vencida(t) ? ` (${L('vencida', 'overdue')})` : ''}</td><td>${esc(t.responsableCierre || '—')}</td><td>${(t.evidencias || []).length || '—'}</td><td>${tN(t.estado)}${t.cierre ? ' · ' + esc(t.cierre) : ''}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${L('Sin tareas. Usa «Nueva tarea» o créalas desde el detalle de un requisito.', 'No tasks. Use “New task” or create them from a requirement’s detail.')}</td></tr>`}
  </tbody></table>`;
  $('#tNueva').onclick = () => abrirTarea(null, '');
  $('#main').querySelectorAll('[data-tarea]').forEach(x => x.onclick = () => abrirTarea(x.dataset.tarea));
}
let tDraft = null;
function abrirTarea(id, reqId) {
  if (id !== undefined) { const t = id ? db.tareas.find(q => q.id === id) : null;
    tDraft = t ? JSON.parse(JSON.stringify(t)) : { id: uid('T'), nueva: true, reqId: reqId || '', titulo: '', acciones: '', responsable: '', inicio: hoy(), vence: '', estado: 'abierta', responsableCierre: '', cierre: '', evidencias: [], notas: '' }; }
  const t = tDraft; t.evidencias ||= [];
  const campo = (id, lbl, val, tipo) => `<div><label>${lbl}</label><input id="${id}" type="${tipo || 'text'}" value="${esc(val || '')}"></div>`;
  mostrarPanel(`
  <div style="display:flex;justify-content:space-between;gap:1rem"><h2>${t.nueva ? L('Nueva tarea', 'New task') : L('Tarea', 'Task')}</h2><button id="pCerrar">${L('Cerrar', 'Close')} ✕</button></div>
  <label>${L('Tarea / hallazgo a atender', 'Task / finding to address')}</label><input id="kTit" style="width:100%" value="${esc(t.titulo)}">
  <div class="row">${campo('kReq', L('Requisito relacionado (ID, opcional)', 'Related requirement (ID, optional)'), t.reqId)}
    <div><label>${L('Estado', 'Status')}</label><select id="kEst">${Object.keys(T_EST).map(k => `<option value="${k}" ${t.estado === k ? 'selected' : ''}>${tN(k)}</option>`).join('')}</select></div></div>
  <label>${L('Acciones a realizar', 'Actions to take')}</label><textarea id="kAcc">${esc(t.acciones)}</textarea>
  <div class="row">${campo('kResp', L('Responsable de ejecución', 'Owner'), t.responsable)}${campo('kIni', L('Fecha de inicio', 'Start date'), t.inicio, 'date')}${campo('kVen', L('Fecha compromiso', 'Due date'), t.vence, 'date')}</div>
  <div class="row">${campo('kRespC', L('Responsable de cierre (quien verifica)', 'Closure owner (verifier)'), t.responsableCierre)}${campo('kCie', L('Fecha de cierre', 'Closure date'), t.cierre, 'date')}</div>
  <section><h3>${L('Evidencia de la tarea', 'Task evidence')}</h3>
    ${t.evidencias.map(v => filaEv(v, 'deltev')).join('') || `<span class="muted">${L('Sin evidencia.', 'No evidence.')}</span>`}
    <div class="row" style="margin-top:.5rem"><div><label>${L('Descripción', 'Description')}</label><input id="kvDesc"></div><div><label>${L('Liga', 'Link')}</label><input id="kvUrl" placeholder="https://…"></div><button id="kvLiga">${L('Agregar liga', 'Add link')}</button><button id="kvArch">${L('Adjuntar archivo…', 'Attach file…')}</button></div></section>
  <label>${L('Notas de seguimiento', 'Follow-up notes')}</label><textarea id="kNotas">${esc(t.notas)}</textarea>
  <div class="row" style="margin-top:.8rem;justify-content:space-between"><button id="kGuardar" class="primary">${L('Guardar tarea', 'Save task')}</button>${t.nueva ? '' : `<button id="kBorrar" class="danger">${L('Eliminar tarea', 'Delete task')}</button>`}</div>`);
  const leer = () => Object.assign(t, { titulo: $('#kTit').value.trim(), reqId: $('#kReq').value.trim(), estado: $('#kEst').value, acciones: $('#kAcc').value.trim(), responsable: $('#kResp').value.trim(),
    inicio: $('#kIni').value, vence: $('#kVen').value, responsableCierre: $('#kRespC').value.trim(), cierre: $('#kCie').value, notas: $('#kNotas').value.trim() });
  const b = $('#panelBody');
  $('#pCerrar').onclick = cerrarPanel;
  $('#kvLiga').onclick = () => { leer(); const u = urlSegura($('#kvUrl').value.trim()); if (!u) return alert(L('Escribe una liga que empiece con https://', 'Enter a link starting with https://')); t.evidencias.push({ id: uid('E'), tipo: 'liga', nombre: $('#kvDesc').value.trim() || u, url: u, fecha: hoy(), desc: '' }); abrirTarea(); };
  $('#kvArch').onclick = () => { leer(); const d = $('#kvDesc').value.trim(); adjuntar(['evidencia', '_tareas', t.id], (n, ruta) => { t.evidencias.push({ id: uid('E'), tipo: 'archivo', nombre: n, ruta, fecha: hoy(), desc: d }); abrirTarea(); }); };
  b.querySelectorAll('[data-file]').forEach(x => x.onclick = () => abrirArchivo(x.dataset.file));
  b.querySelectorAll('[data-deltev]').forEach(x => x.onclick = () => { leer(); t.evidencias = t.evidencias.filter(q => q.id !== x.dataset.deltev); abrirTarea(); });
  $('#kGuardar').onclick = () => { leer();
    if (!t.titulo) return alert(L('Escribe la tarea.', 'Enter the task.'));
    if (t.reqId && !reqs().some(r => r.id === t.reqId)) return alert(L('El ID de requisito no existe. Déjalo vacío o corrígelo.', 'That requirement ID does not exist. Leave it blank or correct it.'));
    if (t.estado === 'cerrada' && !t.cierre) t.cierre = hoy();
    delete t.nueva; const i = db.tareas.findIndex(q => q.id === t.id); if (i >= 0) db.tareas[i] = t; else db.tareas.push(t);
    marcar(); cerrarPanel(); render(); };
  if ($('#kBorrar')) $('#kBorrar').onclick = () => { if (!confirm(L('¿Eliminar esta tarea?', 'Delete this task?'))) return; db.tareas = db.tareas.filter(q => q.id !== t.id); marcar(); cerrarPanel(); render(); };
}

// ---------- novedades legales ----------
function vNovedades() {
  const ns = [...novedadesRepo.novedades].sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  $('#main').innerHTML = `<h2>${L('Novedades legales', 'Legal updates')}</h2>
  <p class="muted">${L('Esta lista se actualiza sola: el repositorio revisa el Diario Oficial de la Federación los días 1 y 15 de cada mes y agrega aquí las publicaciones de STPS, SEMARNAT y temas relacionados. Cada novedad es un aviso para revisar, no una conclusión: confirma en la fuente oficial si genera un requisito nuevo.',
    'This list updates itself: the repository checks the Diario Oficial de la Federación on the 1st and 15th of each month and adds STPS, SEMARNAT and related publications here. Each item is a prompt to review, not a conclusion: confirm in the official source whether it creates a new requirement.')}
  ${L('Última revisión automática', 'Last automatic check')}: <b>${esc(novedadesRepo.actualizado || L('aún no se ha ejecutado', 'not run yet'))}</b>.</p>
  <div class="grid">${ns.map(n => { const st = db.novedades[n.id];
    return `<div class="card nov ${esc(n.impacto || '')}"><h3>${esc(n.titulo)} ${st ? `<span class="tag">${esc(st)}</span>` : `<span class="tag warn">${L('nueva', 'new')}</span>`}</h3>
    <p class="muted">${esc(n.fecha || '')} · ${esc(n.fuente || '')}${n.tema ? ' · ' + esc(n.tema) : ''}</p>${n.resumen ? `<p>${esc(n.resumen)}</p>` : ''}
    ${urlSegura(n.url) ? `<p><a href="${esc(urlSegura(n.url))}" target="_blank" rel="noopener">${L('Ver publicación oficial', 'Open official publication')} ↗</a></p>` : ''}
    <div class="row" style="justify-content:flex-start"><button class="primary" data-nacep="${esc(n.id)}">${L('Marcar como revisada', 'Mark as reviewed')}</button><button data-ntarea="${esc(n.id)}">${L('Crear tarea', 'Create task')}</button><button data-nreq="${esc(n.id)}">${L('Crear requisito', 'Create requirement')}</button><button data-ndesc="${esc(n.id)}">${L('Descartar', 'Dismiss')}</button></div></div>`; }).join('') || `<div class="card muted">${L('No hay novedades registradas.', 'No updates recorded.')}</div>`}</div>`;
  const m = $('#main'), busca = id => novedadesRepo.novedades.find(n => n.id === id);
  m.querySelectorAll('[data-nacep]').forEach(b => b.onclick = () => { db.novedades[b.dataset.nacep] = L('revisada', 'reviewed'); marcar(); render(); });
  m.querySelectorAll('[data-ndesc]').forEach(b => b.onclick = () => { db.novedades[b.dataset.ndesc] = L('descartada', 'dismissed'); marcar(); render(); });
  m.querySelectorAll('[data-ntarea]').forEach(b => b.onclick = () => { const n = busca(b.dataset.ntarea); abrirTarea(null, ''); Object.assign(tDraft, { titulo: L('Evaluar novedad legal: ', 'Assess legal update: ') + n.titulo.slice(0, 160), notas: n.url || '' }); abrirTarea(); });
  m.querySelectorAll('[data-nreq]').forEach(b => b.onclick = () => { const n = busca(b.dataset.nreq);
    db.reqsPropios.push({ id: 'NOV-' + Date.now().toString(36), modulo: 'otros', categoria: L('Derivados de novedades legales', 'From legal updates'), num: '', texto: n.titulo, ref: { nom: '', ley: n.fuente || 'DOF', reglamento: '', articulo: n.fecha || '' }, refEstado: 'por_validar' });
    db.novedades[n.id] = L('requisito creado', 'requirement created'); marcar(); render(); });
}
function elegirArchivo(cb) { const fp = $('#filePick'); fp.value = ''; fp.onchange = () => fp.files[0] && cb(fp.files[0]).catch(e => alert(L('No se pudo leer el archivo: ', 'Could not read the file: ') + e.message)); fp.click(); }

// ---------- configuración ----------
function vConfig() {
  const e = db.empresa;
  $('#main').innerHTML = `<div class="grid cols2">
  <div class="card"><h2>${L('Carpeta de datos', 'Data folder')}</h2>
    <p>${dirHandle ? `${L('Conectada', 'Connected')}: <b>${esc(dirHandle.name)}</b>. ${L('Ahí se guardan', 'It stores')} <code>datos.json</code> ${L('y la subcarpeta', 'and the subfolder')} <code>evidencia/</code>.` : L('Sin carpeta: los datos se guardan solo en este navegador y no se pueden adjuntar archivos.', 'No folder: data is saved only in this browser and files cannot be attached.')}</p>
    <p class="muted">${FS_OK ? L('Elige una carpeta de la red local para que otras personas abran los mismos datos. Solo una persona debe editar a la vez; al guardar se avisa si alguien más guardó antes.', 'Choose a folder on the local network so others can open the same data. Only one person should edit at a time; saving warns you if someone else saved first.') : L('Este navegador no permite conectar carpetas. Usa Chrome o Edge en PC.', 'This browser cannot connect folders. Use Chrome or Edge on a PC.')}</p>
    <div class="row"><button id="cCarpeta" class="primary">${dirHandle ? L('Cambiar carpeta…', 'Change folder…') : L('Elegir carpeta…', 'Choose folder…')}</button></div>
    <label>${L('Tu nombre (se registra al guardar y en el informe)', 'Your name (recorded on save and in the report)')}</label><input id="cUsuario" value="${esc(localStorage.getItem('usuario') || '')}"></div>
  <div class="card"><h2>${L('Respaldo y traslado', 'Backup and transfer')}</h2>
    <p class="muted">${L('El respaldo es un ZIP con los datos y todos los archivos de evidencia. Para cambiar de PC: descarga el respaldo, abre la app en la otra PC, conecta una carpeta y restaura.', 'The backup is a ZIP with the data and all evidence files. To move to another PC: download the backup, open the app there, connect a folder and restore.')}</p>
    <div class="row"><button id="cResp" class="primary">${L('Descargar respaldo (ZIP)', 'Download backup (ZIP)')}</button><button id="cRest">${L('Restaurar / importar datos…', 'Restore / import data…')}</button></div></div>
  <div class="card"><h2>${L('Empresa', 'Company')}</h2>
    <div class="row"><div><label>${L('Nombre', 'Name')}</label><input id="eNom" value="${esc(e.nombre)}"></div><div><label>${L('Estado', 'State')}</label><input id="eEdo" value="${esc(e.estado)}"></div><div><label>${L('Municipio', 'Municipality')}</label><input id="eMun" value="${esc(e.municipio)}"></div></div>
    <h3 style="margin-top:1rem">${L('Perfil de aplicabilidad', 'Applicability profile')}</h3>
    <p class="muted">${L('Al aplicar el perfil, los requisitos condicionados a una respuesta «No» se marcan como No aplica (solo si están sin evaluar o ya eran No aplica por perfil).', 'When the profile is applied, requirements tied to a “No” answer are marked N/A (only if not yet assessed or already N/A by profile).')}</p>
    ${PERFIL.map(([k, q, qe]) => `<label style="color:inherit"><select data-perfil="${k}"><option value="">—</option><option value="si" ${e.perfil[k] === 'si' ? 'selected' : ''}>${L('Sí', 'Yes')}</option><option value="no" ${e.perfil[k] === 'no' ? 'selected' : ''}>No</option></select> ${esc(L(q, qe))}</label>`).join('')}
    <div class="row" style="margin-top:.6rem"><button id="eAplicar" class="primary">${L('Guardar empresa y aplicar perfil', 'Save company and apply profile')}</button></div></div>
  <div class="card"><h2>${L('Agregar requisito propio', 'Add custom requirement')}</h2>
    <p class="muted">${L('Para requisitos nuevos, condicionantes de permisos o requisitos de cliente/corporativo.', 'For new requirements, permit conditions, or customer/corporate requirements.')}</p>
    <div class="row"><div><label>${L('Módulo', 'Module')}</label><input id="nMod" list="mods" placeholder="stps, ambiental, proteccion_civil…"><datalist id="mods">${modulos().map(m => `<option value="${esc(m.id)}">`).join('')}</datalist></div><div><label>${L('Categoría', 'Category')}</label><input id="nCat"></div></div>
    <label>${L('Requisito', 'Requirement')}</label><textarea id="nTxt"></textarea>
    <div class="row"><div><label>${L('NOM / Ley', 'NOM / Law')}</label><input id="nNom"></div><div><label>${L('Artículo / numeral', 'Article / clause')}</label><input id="nArt"></div></div>
    <button id="nAdd" class="primary" style="margin-top:.6rem">${L('Agregar requisito', 'Add requirement')}</button>
    <p class="muted">${L('Catálogo cargado', 'Loaded catalog')}: ${catalogos.map(m => `${esc(mN(m))} (${m.requisitos.length})`).join(' · ')} · ${L('propios', 'custom')}: ${db.reqsPropios.length}</p></div>
  <div class="card" style="grid-column:1/-1"><h2>${L('Fuentes normativas del catálogo', 'Legal sources of the catalog')}</h2>
    <p class="muted">${L('Versiones de las leyes, reglamentos y normas de donde se extrajo el texto citado. Si una se reforma, hay que actualizar el catálogo.', 'Versions of the laws, regulations and standards from which the quoted text was extracted. If one is amended, the catalog must be updated.')}</p>
    ${catalogos.map(m => `<p><b>${esc(mN(m))}</b> (v${esc(m.version || '')}): ${(m.fuentes || []).map(esc).join(' · ') || '—'}</p>`).join('')}</div>
  </div>`;
  $('#cCarpeta').onclick = elegirCarpeta;
  $('#cUsuario').onchange = ev => localStorage.setItem('usuario', ev.target.value.trim());
  $('#cResp').onclick = () => respaldo().catch(er => alert(L('No se pudo generar el respaldo: ', 'Could not create the backup: ') + er.message));
  $('#cRest').onclick = () => elegirArchivo(restaurar);
  $('#eAplicar').onclick = () => {
    e.nombre = $('#eNom').value.trim(); e.estado = $('#eEdo').value.trim(); e.municipio = $('#eMun').value.trim();
    document.querySelectorAll('[data-perfil]').forEach(s => e.perfil[s.dataset.perfil] = s.value);
    let n = 0;
    for (const r of reqs()) { if (!r.condicion) continue; const resp = e.perfil[r.condicion], s = db.estados[r.id] || {};
      if (resp === 'no' && (!s.estatus || s.estatus === 'sin_evaluar')) { db.estados[r.id] = { estatus: 'na', nota: 'No aplica según perfil de la empresa', fecha: hoy(), porPerfil: true }; n++; }
      else if (resp === 'si' && s.porPerfil) { db.estados[r.id] = { estatus: 'sin_evaluar', nota: '', fecha: hoy() }; n++; } }
    marcar(); render(); alert(L(`Perfil aplicado. ${n} requisito(s) actualizados.`, `Profile applied. ${n} requirement(s) updated.`));
  };
  $('#nAdd').onclick = () => { const txt = $('#nTxt').value.trim(), mod = $('#nMod').value.trim() || 'otros'; if (!txt) return alert(L('Escribe el requisito.', 'Enter the requirement.'));
    db.reqsPropios.push({ id: 'PROP-' + String(db.reqsPropios.length + 1).padStart(3, '0') + '-' + Date.now().toString(36).slice(-3), modulo: mod, categoria: $('#nCat').value.trim() || L('Requisitos propios', 'Custom requirements'), num: '', texto: txt,
      ref: { nom: $('#nNom').value.trim(), ley: '', reglamento: '', articulo: $('#nArt').value.trim() }, refEstado: 'usuario' });
    marcar(); render(); alert(L('Requisito agregado.', 'Requirement added.')); };
}

// ---------- arranque ----------
document.addEventListener('click', ev => {
  const o = ev.target.closest('[data-open]'); if (o) { abrirPanel(o.dataset.open); return; }
  const v = ev.target.closest('#nav [data-view]'); if (v) { vista = v.dataset.view; cerrarPanel(); render(); }
});
$('#overlay').onclick = cerrarPanel;
$('#btnSave').onclick = () => guardar().catch(e => alert(L('No se pudo guardar: ', 'Could not save: ') + e.message));
$('#btnLang').onclick = () => { lang = lang === 'es' ? 'en' : 'es'; localStorage.setItem('lang', lang); cerrarPanel(); render(); };
window.addEventListener('beforeunload', e => { if (sucio) { e.preventDefault(); e.returnValue = ''; } });

(async function init() {
  try {
    const idx = await (await fetch('catalogo/index.json', { cache: 'no-store' })).json();
    catalogos = await Promise.all(idx.catalogos.map(async f => (await fetch('catalogo/' + f, { cache: 'no-store' })).json()));
    try { novedadesRepo = await (await fetch('catalogo/novedades.json', { cache: 'no-store' })).json(); } catch { }
  } catch (e) { banner(L('No se pudo cargar el catálogo. Verifica que la carpeta «catalogo» esté en la raíz del repositorio y que la app se abra desde GitHub Pages. (', 'Could not load the catalog. Check that the “catalogo” folder is at the repository root and the app is opened from GitHub Pages. (') + esc(e.message) + ')'); }
  const local = localStorage.getItem('cumplimiento_db');
  if (local) try { db = normalizar(JSON.parse(local)); } catch { }
  const ok = FS_OK ? await reconectar().catch(() => false) : false;
  if (!ok && !$('#banner').innerHTML && !local) banner(L('Primera vez: ve a <b>Configuración</b> para elegir la carpeta de datos y, si ya tienes un archivo de datos iniciales, restáuralo ahí.', 'First time: go to <b>Settings</b> to choose the data folder and, if you have an initial data file, restore it there.'));
  render();
})();
