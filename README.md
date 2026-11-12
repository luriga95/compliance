# Gestor de Cumplimiento Legal EHS

App web estática (sin servidor) para gestionar el cumplimiento legal: tablero, binder de evidencia,
tareas de seguimiento y buzón de novedades legales.

**El repositorio solo contiene el código y el catálogo de requisitos. Los datos de la empresa
(estatus, evidencia, tareas) viven en la carpeta que cada usuario elige en su PC o red local.**

## Publicar
1. Sube el contenido de esta carpeta a la raíz del repositorio.
2. En GitHub: Settings → Pages → Source: `Deploy from a branch` → rama `main`, carpeta `/ (root)`.
3. Abre la URL de Pages en Chrome o Edge (PC).

## Primer uso
1. Configuración → **Elegir carpeta…** (por ejemplo, una carpeta de la red local).
2. Configuración → **Restaurar / importar datos…** y elige el archivo de datos iniciales, si lo hay.
3. **Guardar**. En la carpeta quedan `datos.json` y `evidencia/<ID del requisito>/`.

## Estructura
- `catalogo/index.json` — lista de catálogos que carga la app.
- `catalogo/*.json` — un archivo por módulo (STPS, ambiental, …). Para agregar un módulo nuevo
  (Protección Civil, municipal, otro estado) se agrega su archivo y se lista en `index.json`.
- `catalogo/novedades.json` — novedades legales detectadas en la revisión periódica.

## Llevarla a otra empresa
Copia el repositorio (fork o plantilla), ajusta los catálogos estatales/municipales y publícalo con
Pages. La empresa nueva elige su propia carpeta, llena el perfil de aplicabilidad y empieza a evaluar.

## Vigilancia legal automática
`.github/workflows/novedades.yml` ejecuta `scripts/novedades.mjs` los días 1 y 15 de cada mes: consulta el
Diario Oficial de la Federación, filtra las publicaciones por tema y actualiza `catalogo/novedades.json`.
La app muestra esas novedades en la pestaña **Novedades** sin intervención manual.

- Para activarla: en GitHub, pestaña **Actions** → habilitar workflows. En Settings → Actions → General →
  *Workflow permissions* elegir **Read and write permissions**.
- Para probarla sin esperar: Actions → "Vigilancia legal (DOF)" → **Run workflow**.
- Los temas vigilados se editan en la lista `TEMAS` de `scripts/novedades.mjs`.
- Solo cubre publicaciones federales (DOF). Los periódicos oficiales estatales no tienen un servicio equivalente.
