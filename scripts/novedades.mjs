// Revisión automática del Diario Oficial de la Federación (DOF).
// Lo ejecuta GitHub Actions (.github/workflows/novedades.yml) los días 1 y 15 de cada mes.
// Consulta el servicio JSON del DOF (SIDOF) día por día, filtra las publicaciones por tema
// y agrega las nuevas a catalogo/novedades.json. No requiere dependencias (Node 20+).
import { readFile, writeFile } from 'node:fs/promises';

const ARCHIVO = 'catalogo/novedades.json';
const HOSTS = ['https://sidofqa.segob.gob.mx/dof/sidof', 'https://sidof.segob.gob.mx/dof/sidof'];
const DIAS_MAX = 45;      // ventana máxima hacia atrás
const CONSERVAR = 300;    // novedades que se conservan en el archivo

// Temas vigilados: edita esta lista para adaptar la vigilancia a otra empresa.
export const TEMAS = [
  ['Seguridad y salud en el trabajo', /NOM-\d{3}(-\d)?-STPS|Secretar[ií]a del Trabajo y Previsi[oó]n Social|seguridad y salud en el trabajo|Ley Federal del Trabajo|Ley del Seguro Social|riesgos de trabajo|subcontrataci[oó]n/i],
  ['Medio ambiente', /NOM-\d{3}(-\d)?-(SEMARNAT|ECOL|ASEA|CONAGUA)|Medio Ambiente y Recursos Naturales|Equilibrio Ecol[oó]gico|Gesti[oó]n Integral de los Residuos|residuos peligrosos|Aguas Nacionales|Comisi[oó]n Nacional del Agua|descargas de aguas residuales|emisiones a la atm[oó]sfera|impacto ambiental|C[eé]dula de Operaci[oó]n Anual|Responsabilidad Ambiental|PROFEPA/i],
  ['Protección civil e instalaciones', /Protecci[oó]n Civil|NOM-\d{3}-(SEGOB|SEDE|SESH)/i],
];

// Recorre la respuesta (cuya forma exacta puede variar) y devuelve todo objeto que tenga un título.
export function extraerNotas(json, out = []) {
  if (Array.isArray(json)) json.forEach(x => extraerNotas(x, out));
  else if (json && typeof json === 'object') {
    if (typeof json.titulo === 'string' && json.titulo.trim()) out.push(json);
    else Object.values(json).forEach(x => extraerNotas(x, out));
  }
  return out;
}
export function aNovedad(nota, fechaISO) {
  const texto = Object.values(nota).filter(v => typeof v === 'string').join(' · ');
  const tema = TEMAS.find(([, re]) => re.test(texto));
  if (!tema) return null;
  const cod = nota.codNota ?? nota.codigo ?? nota.codigoNota ?? nota.id;
  const [y, m, d] = fechaISO.split('-');
  const dep = [nota.nombreCodOrgaUno, nota.nombreCodOrgaDos, nota.dependencia, nota.organismo].find(v => typeof v === 'string' && v.trim());
  const titulo = nota.titulo.replace(/\s+/g, ' ').trim();
  return {
    id: 'DOF-' + (cod ?? fechaISO + '-' + titulo.slice(0, 40)),
    fecha: fechaISO, fuente: 'DOF' + (dep ? ' · ' + dep.trim() : ''), tema: tema[0], titulo,
    url: cod ? `https://dof.gob.mx/nota_detalle.php?codigo=${cod}&fecha=${d}/${m}/${y}` : '',
  };
}
async function notasDelDia(fechaISO) {
  const [y, m, d] = fechaISO.split('-');
  let ultimo;
  for (const h of HOSTS) {
    try {
      const r = await fetch(`${h}/notas/${d}-${m}-${y}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return extraerNotas(await r.json());
    } catch (e) { ultimo = e; }
  }
  throw ultimo;
}

async function main() {
  let actual = { actualizado: '', novedades: [] };
  try { actual = JSON.parse(await readFile(ARCHIVO, 'utf8')); } catch { }
  const hoy = new Date(); const fin = hoy.toISOString().slice(0, 10);
  const desde = new Date(hoy.getTime() - DIAS_MAX * 864e5);
  let ini = actual.actualizado ? new Date(actual.actualizado + 'T00:00:00Z') : new Date(hoy.getTime() - 16 * 864e5);
  if (isNaN(ini) || ini < desde) ini = desde;
  const ids = new Set(actual.novedades.map(n => n.id));
  let ok = 0, fallas = 0, nuevas = 0;
  for (let t = ini.getTime(); t <= hoy.getTime(); t += 864e5) {
    const dia = new Date(t); if ([0, 6].includes(dia.getUTCDay())) continue;   // el DOF se publica de lunes a viernes
    const iso = dia.toISOString().slice(0, 10);
    try {
      for (const nota of await notasDelDia(iso)) { const n = aNovedad(nota, iso); if (n && !ids.has(n.id)) { ids.add(n.id); actual.novedades.push(n); nuevas++; } }
      ok++;
    } catch (e) { fallas++; console.error(`No se pudo consultar ${iso}: ${e.message}`); }
  }
  if (!ok) { console.error('El servicio del DOF no respondió en ningún día; no se modifica el archivo.'); process.exit(1); }
  actual.novedades.sort((a, b) => b.fecha.localeCompare(a.fecha)); actual.novedades = actual.novedades.slice(0, CONSERVAR);
  actual.actualizado = fin;
  await writeFile(ARCHIVO, JSON.stringify(actual, null, 1) + '\n');
  console.log(`Días consultados: ${ok} (con falla: ${fallas}). Novedades nuevas: ${nuevas}. Total en archivo: ${actual.novedades.length}.`);
}
if (process.argv[1] && process.argv[1].endsWith('novedades.mjs')) main();
