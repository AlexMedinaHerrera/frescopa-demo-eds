/*
 * Panel QA (app de da.live).
 * Abrir en: https://da.live/app/{org}/{site}/tools/qa  (otra rama: ?ref={rama})
 * o directamente en https://{rama}--{site}--{org}.aem.page/tools/qa.html
 * Desde el Sidekick (botón "QA") recibe ?referrer=<url de la página> y la audita sola.
 *
 * Comprueba, por cada ruta:
 *   - enlaces e imágenes rotas (página, nav y footer de su idioma)
 *   - SEO: title, description, og:image, noindex, h1 y saltos de encabezado
 *   - accesibilidad: imágenes sin alt, enlaces sin texto o con texto genérico
 *   - contenido: lorem ipsum / TODO, enlaces a preview o localhost, anclas inexistentes
 *   - idiomas: que existan las versiones en/es/fr/jp y que no se enlace a otro idioma
 * y, una vez por ejecución, la hoja /redirects.json.
 *
 * Solo puede leer estados HTTP del mismo origen (aem.page no envía CORS),
 * así que valida la rama desde la que se sirve el panel.
 */

const STORAGE_KEY = 'qa-panel-paths';
const CONCURRENCY = 6;
const TIMEOUT_MS = 15000;
const SKIP_PROTOCOLS = ['mailto:', 'tel:', 'javascript:', 'data:', 'blob:', 'sms:']; // eslint-disable-line no-script-url
const OPTIONS = ['fragments', 'external', 'seo', 'i18n', 'redirects'];

/* Mismo valor que LOCALES en scripts/scripts.js (no se importa: ese módulo arranca la página). */
const LOCALES = ['es', 'fr', 'jp'];
const LOCALE_ROOTS = ['', ...LOCALES.map((l) => `/${l}`)];

const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;
const GENERIC_LINK_TEXTS = [
  'aquí', 'aqui', 'click aquí', 'haz clic aquí', 'pincha aquí', 'leer más', 'ver más', 'más',
  'más información', 'saber más', 'here', 'click here', 'read more', 'more', 'learn more',
  'ici', 'cliquez ici', 'en savoir plus', 'lire la suite', 'こちら', '詳細',
];
const PREVIEW_HOSTS = /(^localhost$)|(\.aem\.page$)|(\.hlx\.page$)/;

/* estados: ok | error | warn | info */
const LABELS = {
  ok: 'OK',
  error: 'Error',
  warn: 'Aviso',
  info: 'Info',
};
const SEVERITY = {
  error: 0, warn: 1, info: 2, ok: 3,
};
const KIND_LABELS = {
  enlace: 'Enlace',
  imagen: 'Imagen',
  seo: 'SEO',
  accesibilidad: 'Accesibilidad',
  contenido: 'Contenido',
  idioma: 'Idioma',
  redirect: 'Redirect',
};

const cache = new Map();
let lastReport = [];

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (e) {
    // almacenamiento no disponible: no pasa nada
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  });
  children.flat().forEach((c) => {
    if (c === null || c === undefined) return;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  });
  return node;
}

const worst = (a, b) => (SEVERITY[a] <= SEVERITY[b] ? a : b);
const isProblem = (r) => r.status === 'error' || r.status === 'warn';
const row = (kind, status, message, url = '', context = '') => ({
  kind, status, message, url, context,
});

/* ---------- idiomas ---------- */

function localeOf(path) {
  const [first] = path.split('/').filter(Boolean);
  return LOCALES.includes(first) ? `/${first}` : '';
}

function basePathOf(path) {
  return path.slice(localeOf(path).length) || '/';
}

const localeLabel = (root) => (root ? root.slice(1) : 'en');

/* ---------- red ---------- */

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

function describeError(e) {
  return e && e.name === 'AbortError' ? `Tiempo agotado (${TIMEOUT_MS / 1000}s)` : 'Error de red';
}

async function checkSameOrigin(url) {
  try {
    let res = await fetchWithTimeout(url, { method: 'HEAD' });
    if (res.status === 405 || res.status === 501) {
      res = await fetchWithTimeout(url, { method: 'GET' });
    }
    if (!res.ok) return { status: 'error', code: res.status, message: `HTTP ${res.status}` };
    if (res.redirected) {
      return { status: 'warn', code: res.status, message: `Redirige a ${res.url.replace(window.location.origin, '')}` };
    }
    return { status: 'ok', code: res.status, message: `HTTP ${res.status}` };
  } catch (e) {
    return { status: 'error', code: 0, message: describeError(e) };
  }
}

async function checkExternalLink(url) {
  // Sin CORS solo podemos saber si el servidor responde, no su código HTTP.
  try {
    await fetchWithTimeout(url, { method: 'GET', mode: 'no-cors' });
    return { status: 'info', code: null, message: 'Responde (código no visible por CORS)' };
  } catch (e) {
    return { status: 'error', code: 0, message: `No accesible: ${describeError(e)}` };
  }
}

function checkExternalImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      resolve({ status: 'error', code: 0, message: `Tiempo agotado (${TIMEOUT_MS / 1000}s)` });
    }, TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve({ status: 'ok', code: null, message: `${img.naturalWidth}×${img.naturalHeight}px` });
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve({ status: 'error', code: 0, message: 'La imagen no carga' });
    };
    img.src = url;
  });
}

function checkUrl(url, kind, checkExternal) {
  const sameOrigin = new URL(url).origin === window.location.origin;
  const key = `${sameOrigin ? 'local' : kind}|${url}`;
  if (cache.has(key)) return cache.get(key);
  let promise;
  if (sameOrigin) promise = checkSameOrigin(url);
  else if (kind === 'imagen') promise = checkExternalImage(url);
  else if (checkExternal) promise = checkExternalLink(url);
  else promise = Promise.resolve({ status: 'info', code: null, message: 'Externo (omitido)' });
  cache.set(key, promise);
  return promise;
}

/* ¿La ruta origen de un redirect redirige de verdad? (sin seguir la redirección) */
async function checkRedirectSource(url) {
  try {
    const res = await fetchWithTimeout(url, { redirect: 'manual' });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return { status: 'ok' };
    if (res.ok) return { status: 'warn', message: `El origen no redirige: responde HTTP ${res.status} (¿hay una página en esa ruta o falta hacer preview de la hoja?)` };
    return { status: 'error', message: `El origen no redirige: HTTP ${res.status} (¿falta hacer preview de la hoja?)` };
  } catch (e) {
    return { status: 'error', message: `El origen no responde: ${describeError(e)}` };
  }
}

async function runPool(tasks, limit, onDone) {
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop
      await tasks[i]();
      onDone();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

/* ---------- extracción de enlaces e imágenes ---------- */

function firstSrcsetUrl(srcset) {
  return (srcset || '').split(',')[0].trim().split(/\s+/)[0] || '';
}

function shouldSkip(raw) {
  const lower = raw.trim().toLowerCase();
  return SKIP_PROTOCOLS.some((p) => lower.startsWith(p));
}

/* Devuelve { items, issues } con los enlaces/imágenes de un documento ya parseado. */
function extractTargets(doc, baseUrl, scope) {
  const items = [];
  const issues = [];
  const seen = new Set();
  const root = doc.querySelector(scope) || doc.body || doc;

  const add = (kind, raw, context) => {
    if (raw === null || raw === undefined) return;
    const value = raw.trim();
    const noun = kind === 'imagen' ? 'Imagen' : 'Enlace';
    if (!value) {
      issues.push(row(kind, kind === 'imagen' ? 'error' : 'warn', `${noun} sin URL`, '(vacío)', context));
      return;
    }
    if (value.startsWith('#')) {
      if (value === '#') issues.push(row(kind, 'warn', 'Enlace a "#" sin destino', value, context));
      return;
    }
    if (shouldSkip(value)) return;
    let url;
    try {
      url = new URL(value, baseUrl);
    } catch (e) {
      issues.push(row(kind, 'error', 'URL mal formada', value, context));
      return;
    }
    if (!url.protocol.startsWith('http')) return;
    url.hash = '';
    const { href } = url;
    const key = `${kind}|${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ kind, url: href, context });
  };

  root.querySelectorAll('a').forEach((a) => {
    add('enlace', a.getAttribute('href') ?? '', a.textContent.trim().slice(0, 80));
  });
  root.querySelectorAll('img').forEach((img) => {
    const picture = img.closest('picture');
    // en EDS el <img> es el fallback; validamos su src y el primer <source> (webp)
    add('imagen', img.getAttribute('src') ?? '', img.getAttribute('alt') || img.dataset.title || '');
    if (picture) {
      const source = picture.querySelector('source');
      if (source) add('imagen', firstSrcsetUrl(source.getAttribute('srcset')), 'source (webp)');
    }
  });
  if (scope === 'main') {
    const og = doc.querySelector('meta[property="og:image"]');
    if (og) add('imagen', og.getAttribute('content'), 'og:image');
  }
  return { items, issues };
}

/* ---------- SEO, accesibilidad y contenido ---------- */

function metaContent(doc, selector) {
  const meta = doc.querySelector(selector);
  return meta ? (meta.getAttribute('content') || '').trim() : '';
}

function seoChecks(doc, main) {
  const rows = [];
  const title = (doc.querySelector('title')?.textContent || '').trim();
  if (!title) rows.push(row('seo', 'error', 'La página no tiene <title>'));
  else if (title.length > TITLE_MAX) rows.push(row('seo', 'warn', `Título largo: ${title.length} caracteres (máx. recomendado ${TITLE_MAX})`, '', title));
  else rows.push(row('seo', 'ok', `Título: ${title.length} caracteres`, '', title));

  const description = metaContent(doc, 'meta[name="description"]');
  if (!description) rows.push(row('seo', 'warn', 'Sin meta description'));
  else if (description.length > DESCRIPTION_MAX) rows.push(row('seo', 'warn', `Description larga: ${description.length} caracteres (máx. recomendado ${DESCRIPTION_MAX})`, '', description.slice(0, 80)));
  else rows.push(row('seo', 'ok', `Description: ${description.length} caracteres`, '', description.slice(0, 80)));

  if (!metaContent(doc, 'meta[property="og:image"]')) rows.push(row('seo', 'warn', 'Sin og:image (imagen al compartir en redes)'));

  if (/noindex/i.test(metaContent(doc, 'meta[name="robots"]'))) {
    rows.push(row('seo', 'info', 'Página marcada como noindex: no saldrá en buscadores ni en el sitemap'));
  }

  const h1s = main.querySelectorAll('h1');
  if (!h1s.length) rows.push(row('seo', 'error', 'La página no tiene h1'));
  else if (h1s.length > 1) rows.push(row('seo', 'warn', `La página tiene ${h1s.length} h1 (debería haber uno)`, '', [...h1s].map((h) => h.textContent.trim()).join(' | ').slice(0, 80)));

  let previous = 0;
  main.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    const level = Number(h.tagName[1]);
    if (previous && level > previous + 1) {
      rows.push(row('seo', 'warn', `Salto de encabezado: de h${previous} a h${level}`, '', h.textContent.trim().slice(0, 80)));
    }
    previous = level;
  });
  return rows;
}

function accessibleName(a) {
  const alts = [...a.querySelectorAll('img')].map((img) => img.getAttribute('alt') || '');
  return [a.textContent, ...alts, a.getAttribute('aria-label'), a.getAttribute('title')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function a11yAndContentChecks(doc, main) {
  const rows = [];
  const seenImages = new Set();
  main.querySelectorAll('img').forEach((img) => {
    const src = (img.getAttribute('src') || '').split('?')[0];
    if (seenImages.has(src) || img.closest('a')) return;
    seenImages.add(src);
    if (!(img.getAttribute('alt') || '').trim()) {
      rows.push(row('accesibilidad', 'warn', 'Imagen sin texto alternativo (alt)', src, img.dataset.title || ''));
    }
  });

  main.querySelectorAll('a').forEach((a) => {
    const href = (a.getAttribute('href') || '').trim();
    const name = accessibleName(a);
    if (!name) {
      rows.push(row('accesibilidad', 'error', 'Enlace sin texto: el lector de pantalla no puede anunciarlo', href));
    } else if (GENERIC_LINK_TEXTS.includes(name.toLowerCase().replace(/[.:…»›→]+$/, '').trim())) {
      rows.push(row('accesibilidad', 'warn', 'Texto de enlace genérico: no dice a dónde lleva', href, name));
    }

    if (href.startsWith('#') && href.length > 1) {
      const id = decodeURIComponent(href.slice(1));
      if (!doc.getElementById(id)) rows.push(row('contenido', 'warn', `El ancla ${href} no existe en la página`, href, name));
    } else if (/^https?:/i.test(href)) {
      try {
        const { hostname } = new URL(href);
        if (PREVIEW_HOSTS.test(hostname)) {
          rows.push(row('contenido', 'warn', 'Enlace absoluto a un entorno de preview o local: usa una ruta relativa (/…)', href, name));
        }
      } catch (e) {
        // URL mal formada: ya la marca la comprobación de enlaces
      }
    }
  });

  const text = main.textContent || '';
  if (/lorem ipsum/i.test(text)) rows.push(row('contenido', 'warn', 'Contiene texto de relleno (lorem ipsum)'));
  const todo = text.match(/\b(TODO|TBD|FIXME|XXX)\b/);
  if (todo) rows.push(row('contenido', 'warn', `Contiene una marca pendiente: "${todo[1]}"`));
  return rows;
}

/* Enlaces internos de la página que saltan a otro idioma. */
function crossLocaleLinks(main, pageUrl, pagePath) {
  const rows = [];
  const pageRoot = localeOf(pagePath);
  const seen = new Set();
  main.querySelectorAll('a[href]').forEach((a) => {
    let url;
    try {
      url = new URL(a.getAttribute('href'), pageUrl);
    } catch (e) {
      return;
    }
    const path = url.pathname;
    const isPage = url.origin === window.location.origin
      && !/\.[a-z0-9]+$/i.test(path) && !path.includes('/media_') && !path.startsWith('/tools/');
    if (!isPage || seen.has(path)) return;
    seen.add(path);
    const linkRoot = localeOf(path);
    if (linkRoot !== pageRoot) {
      rows.push(row(
        'idioma',
        'warn',
        `Enlace a la versión ${localeLabel(linkRoot)} desde una página ${localeLabel(pageRoot)}`,
        url.href,
        a.textContent.trim().slice(0, 80),
      ));
    }
  });
  return rows;
}

/* Tareas que comprueban que existen las versiones de la página en los demás idiomas. */
function translationTasks(entry, pagePath) {
  const own = localeOf(pagePath);
  const base = basePathOf(pagePath);
  return LOCALE_ROOTS.filter((root) => root !== own).map((root) => async () => {
    const siblingPath = base === '/' ? `${root}/` : `${root}${base}`;
    const url = new URL(siblingPath, window.location.origin).href;
    const result = await checkUrl(url, 'enlace', false);
    const lang = localeLabel(root);
    if (result.code === 404) {
      entry.rows.push(row('idioma', 'warn', `Falta la versión ${lang}`, url));
    } else if (result.status === 'error') {
      entry.rows.push(row('idioma', 'error', `La versión ${lang} no carga: ${result.message}`, url));
    } else {
      entry.rows.push(row('idioma', 'ok', `Existe la versión ${lang}`, url));
    }
  });
}

/* ---------- auditoría de páginas ---------- */

function normalizePath(line) {
  const value = line.trim();
  if (!value || value.startsWith('//')) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) {
      return { error: `Otro origen (${url.origin}). Abre el panel en esa rama.`, raw: value };
    }
    return { path: `${url.pathname}${url.search}` };
  } catch (e) {
    return { error: 'Ruta no válida', raw: value };
  }
}

async function loadDocument(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) return { error: `HTTP ${res.status}`, code: res.status };
  const html = await res.text();
  return { doc: new DOMParser().parseFromString(html, 'text/html'), finalUrl: res.url };
}

async function auditSource(source, options) {
  const entry = {
    title: source.title,
    url: source.url,
    path: source.path,
    status: 'ok',
    message: '',
    rows: [],
  };
  let loaded;
  try {
    loaded = await loadDocument(source.url);
  } catch (e) {
    loaded = { error: describeError(e) };
  }
  if (loaded.error) {
    entry.status = 'error';
    entry.message = `La página no carga: ${loaded.error}`;
    return { entry, tasks: [] };
  }
  const { doc } = loaded;
  const pageUrl = loaded.finalUrl || source.url;
  const { items, issues } = extractTargets(doc, pageUrl, source.scope);
  entry.rows.push(...issues);
  entry.doc = doc;
  const tasks = items.map((item) => async () => {
    const result = await checkUrl(item.url, item.kind, options.external);
    entry.rows.push({ ...item, ...result });
  });

  if (source.scope === 'main') {
    const main = doc.querySelector('main') || doc.body;
    if (options.seo) {
      entry.rows.push(...seoChecks(doc, main), ...a11yAndContentChecks(doc, main));
    }
    if (options.i18n) {
      entry.rows.push(...crossLocaleLinks(main, pageUrl, source.path));
      tasks.push(...translationTasks(entry, source.path));
    }
  }
  return { entry, tasks };
}

/* Como blocks/header y blocks/footer: metadata nav/footer o /nav, con prefijo de idioma. */
function fragmentPath(doc, name, pagePath) {
  const value = metaContent(doc, `meta[name="${name}"]`) || `/${name}`;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    let path = url.pathname.replace(/(\.plain)?\.html$/, '');
    const root = localeOf(pagePath);
    if (root && !path.startsWith(`${root}/`)) path = `${root}${path}`;
    return path;
  } catch (e) {
    return null;
  }
}

/* ---------- hoja de redirects ---------- */

function sheetRows(json) {
  if (Array.isArray(json?.data)) return json.data;
  const names = json?.[':names'] || [];
  const sheet = json?.default || json?.[names[0]];
  return Array.isArray(sheet?.data) ? sheet.data : [];
}

function pick(obj, name) {
  const key = Object.keys(obj).find((k) => k.toLowerCase() === name);
  return key ? String(obj[key] ?? '').trim() : '';
}

function internalPath(value) {
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin ? url.pathname : null;
  } catch (e) {
    return null;
  }
}

async function auditRedirects(options) {
  const url = new URL('/redirects.json?limit=10000', window.location.origin).href;
  const entry = {
    title: 'Hoja de redirects (/redirects)',
    url,
    path: '/redirects',
    sheet: true,
    status: 'ok',
    message: '',
    rows: [],
  };
  let json;
  try {
    const res = await fetchWithTimeout(url);
    if (res.status === 404) {
      entry.rows.push(row('redirect', 'info', 'No hay hoja /redirects en esta rama (o no tiene preview)'));
      return { entry, tasks: [] };
    }
    if (!res.ok) {
      entry.status = 'error';
      entry.message = `La hoja de redirects no carga: HTTP ${res.status}`;
      return { entry, tasks: [] };
    }
    json = await res.json();
  } catch (e) {
    entry.status = 'error';
    entry.message = `La hoja de redirects no carga: ${describeError(e)}`;
    return { entry, tasks: [] };
  }

  const redirects = sheetRows(json).map((r, i) => ({
    line: i + 2,
    source: pick(r, 'source'),
    destination: pick(r, 'destination'),
  }));
  const map = new Map();
  const counts = new Map();
  redirects.forEach((r) => {
    counts.set(r.source, (counts.get(r.source) || 0) + 1);
    const dest = internalPath(r.destination);
    if (r.source && dest) map.set(r.source, dest);
  });

  const tasks = [];
  redirects.forEach((r) => {
    const result = row('redirect', 'ok', '', r.source || `(fila ${r.line})`, `→ ${r.destination || '(vacío)'}`);
    const messages = [];
    const flag = (status, message) => {
      result.status = worst(result.status, status);
      messages.push(message);
    };
    entry.rows.push(result);

    if (!r.source || !r.destination) {
      flag('error', `Fila ${r.line}: falta ${r.source ? 'Destination' : 'Source'}`);
    } else {
      if (!r.source.startsWith('/')) flag('error', 'Source debe ser una ruta que empiece por /');
      if (counts.get(r.source) > 1) flag('error', 'Source duplicado en la hoja');
      if (internalPath(r.destination) === r.source) {
        flag('error', 'Redirige a sí mismo');
      } else {
        const chain = [r.source];
        let current = map.get(r.source);
        while (current && map.has(current) && !chain.includes(current) && chain.length < 20) {
          chain.push(current);
          current = map.get(current);
        }
        if (current && chain.includes(current)) flag('error', `Bucle: ${[...chain, current].join(' → ')}`);
        else if (chain.length > 1) flag('warn', `Cadena de redirects: ${[...chain, current].join(' → ')} (apunta directo al destino final)`);
      }
    }

    result.message = messages.join(' · ');
    if (result.status === 'error' || !r.source.startsWith('/')) return;

    tasks.push(async () => {
      const destUrl = new URL(r.destination, window.location.origin).href;
      const [dest, src] = await Promise.all([
        checkUrl(destUrl, 'enlace', options.external),
        checkRedirectSource(new URL(r.source, window.location.origin).href),
      ]);
      if (dest.status === 'error') flag('error', `Destino roto: ${dest.message}`);
      else if (dest.status === 'warn') flag('warn', `El destino vuelve a redirigir: ${dest.message}`);
      if (src.status !== 'ok') flag(src.status, src.message);
      result.message = messages.join(' · ') || 'Redirige correctamente';
    });
  });
  if (!redirects.length) entry.rows.push(row('redirect', 'info', 'La hoja de redirects está vacía'));
  return { entry, tasks };
}

/* ---------- interfaz ---------- */

/* {rama}--{repo}--{org}.aem.page -> https://da.live/edit#/{org}/{repo}{ruta} */
const SITE = (() => {
  const [ref, repo, org] = window.location.hostname.split('.')[0].split('--');
  return org ? { ref, repo, org } : null;
})();

function daEditUrl(path, sheet = false) {
  if (!SITE || !path) return null;
  const docPath = path.endsWith('/') ? `${path}index` : path;
  return `https://da.live/${sheet ? 'sheet' : 'edit'}#/${SITE.org}/${SITE.repo}${docPath}`;
}

const ui = {};

function rowSort(a, b) {
  return SEVERITY[a.status] - SEVERITY[b.status] || a.kind.localeCompare(b.kind);
}

function pageStatus(entry) {
  if (entry.status === 'error' || entry.rows.some((r) => r.status === 'error')) return 'error';
  if (entry.rows.some((r) => r.status === 'warn')) return 'warn';
  return 'ok';
}

function renderSummary(report, options) {
  const rows = report.flatMap((e) => e.rows);
  const of = (kind) => rows.filter((r) => r.kind === kind);
  const tone = (list) => list.reduce((acc, r) => worst(acc, r.status === 'info' ? 'ok' : r.status), 'ok');
  const problems = (list) => list.filter(isProblem).length;
  const brokenPages = report.filter((e) => e.status === 'error').length;

  const stats = [
    ['Páginas', report.length, brokenPages ? 'error' : 'ok', brokenPages ? `${brokenPages} no cargan` : 'todas cargan'],
  ];
  [['enlace', 'Enlaces rotos'], ['imagen', 'Imágenes rotas']].forEach(([kind, label]) => {
    const list = of(kind);
    const broken = list.filter((r) => r.status === 'error').length;
    stats.push([label, broken, broken ? 'error' : tone(list), `de ${list.length} revisados`]);
  });
  const extra = [
    ['seo', 'SEO', options.seo, 'título, description, h1…'],
    ['accesibilidad', 'Accesibilidad', options.seo, 'alt, texto de enlaces'],
    ['contenido', 'Contenido', options.seo, 'relleno, anclas, enlaces a preview'],
    ['idioma', 'Idiomas', options.i18n, 'traducciones y enlaces cruzados'],
    ['redirect', 'Redirects', options.redirects, `${of('redirect').length} reglas`],
  ];
  extra.forEach(([kind, label, enabled, sub]) => {
    if (!enabled) return;
    const list = of(kind);
    stats.push([label, problems(list), tone(list), sub]);
  });

  ui.summary.replaceChildren(...stats.map(([label, value, t, sub]) => el(
    'div',
    { class: `qa-stat qa-${t}` },
    el('span', { class: 'qa-stat-value' }, value),
    el('span', { class: 'qa-stat-label' }, label),
    el('span', { class: 'qa-stat-sub' }, sub),
  )));
  ui.summary.hidden = false;
}

function urlCell(value) {
  if (!value) return '—';
  if (!value.startsWith('http')) return value;
  return el('a', { href: value, target: '_blank', rel: 'noopener' }, value.replace(window.location.origin, ''));
}

function renderResults(report) {
  const onlyIssues = ui.onlyIssues.checked;
  const pages = report.map((entry) => {
    const status = pageStatus(entry);
    const rows = entry.rows.filter((r) => !onlyIssues || isProblem(r)).sort(rowSort);
    const problems = entry.rows.filter(isProblem).length;
    const body = [];
    if (entry.message) body.push(el('p', { class: 'qa-page-error' }, entry.message));
    if (rows.length) {
      body.push(el(
        'div',
        { class: 'qa-table-wrap' },
        el(
          'table',
          { class: 'qa-table' },
          el('thead', {}, el('tr', {}, ['Estado', 'Tipo', 'URL / elemento', 'Detalle', 'Texto / contexto'].map((h) => el('th', { scope: 'col' }, h)))),
          el('tbody', {}, rows.map((r) => el(
            'tr',
            { class: `qa-row-${r.status}` },
            el('td', {}, el('span', { class: `qa-badge qa-${r.status}` }, LABELS[r.status])),
            el('td', {}, KIND_LABELS[r.kind] || r.kind),
            el('td', { class: 'qa-url' }, urlCell(r.url)),
            el('td', {}, r.message),
            el('td', { class: 'qa-context' }, r.context || ''),
          ))),
        ),
      ));
    } else if (!entry.message) {
      body.push(el('p', { class: 'qa-empty' }, onlyIssues ? 'Sin problemas.' : 'Nada que revisar.'));
    }
    const editUrl = daEditUrl(entry.path, entry.sheet);
    return el(
      'details',
      { class: `qa-page qa-page-${status}`, open: status !== 'ok' ? '' : false },
      el(
        'summary',
        {},
        el('span', { class: `qa-badge qa-${status}` }, status === 'ok' ? 'OK' : `${problems || 1} problema${problems === 1 ? '' : 's'}`),
        el('span', { class: 'qa-page-title' }, entry.title),
        el(
          'span',
          { class: 'qa-page-links' },
          el('a', { href: entry.url, target: '_blank', rel: 'noopener' }, 'abrir ↗'),
          editUrl ? el('a', { href: editUrl, target: '_blank', rel: 'noopener' }, 'editar en da.live ↗') : null,
        ),
      ),
      body,
    );
  });
  ui.pages.replaceChildren(...pages);
  ui.results.hidden = false;
}

function setProgress(done, total, text) {
  ui.progress.max = Math.max(total, 1);
  ui.progress.value = done;
  ui.progressText.textContent = text || `${done} / ${total} comprobaciones`;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const header = ['pagina', 'estado', 'tipo', 'url', 'detalle', 'contexto'];
  const lines = [header.join(',')];
  lastReport.forEach((entry) => {
    if (entry.message) lines.push([entry.title, 'error', 'pagina', entry.url, entry.message, ''].map(csvCell).join(','));
    entry.rows.forEach((r) => {
      lines.push([entry.title, r.status, r.kind, r.url, r.message, r.context].map(csvCell).join(','));
    });
  });
  const blob = new Blob([String.fromCharCode(0xfeff), lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `qa-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function readOptions() {
  const data = new FormData(ui.form);
  const options = { lines: (data.get('paths') || '').split('\n') };
  OPTIONS.forEach((name) => { options[name] = data.get(name) === 'on'; });
  return options;
}

async function run({ remember = true } = {}) {
  const options = readOptions();
  if (remember) storageSet(STORAGE_KEY, ui.textarea.value);
  cache.clear();

  const report = [];
  const sources = [];
  const seenPaths = new Set();
  options.lines.map(normalizePath).filter(Boolean).forEach((p) => {
    if (p.error) {
      report.push({
        title: p.raw, url: p.raw, status: 'error', message: p.error, rows: [],
      });
      return;
    }
    if (seenPaths.has(p.path)) return;
    seenPaths.add(p.path);
    const url = new URL(p.path, window.location.origin);
    sources.push({
      title: p.path, url: url.href, path: url.pathname, scope: 'main',
    });
  });

  if (!sources.length && !report.length && !options.redirects) {
    ui.textarea.focus();
    return;
  }

  ui.run.disabled = true;
  ui.exportBtn.disabled = true;
  ui.status.hidden = false;
  setProgress(0, sources.length, 'Cargando páginas…');

  const audited = await Promise.all(sources.map((s) => auditSource(s, options)));
  const allTasks = [];
  const collect = ({ entry, tasks }) => {
    report.push(entry);
    allTasks.push(...tasks);
  };
  audited.forEach(collect);

  if (options.fragments) {
    const fragPaths = new Set();
    audited.forEach(({ entry }) => {
      if (!entry.doc) return;
      ['nav', 'footer'].forEach((name) => {
        const p = fragmentPath(entry.doc, name, entry.path);
        if (p) fragPaths.add(p);
      });
    });
    const fragAudits = await Promise.all([...fragPaths].map((p) => auditSource({
      title: `${p} (fragmento)`,
      path: p,
      url: new URL(`${p}.plain.html`, window.location.origin).href,
      scope: 'body',
    }, options)));
    fragAudits.forEach(collect);
  }

  if (options.redirects) collect(await auditRedirects(options));

  report.forEach((e) => { delete e.doc; });

  let done = 0;
  setProgress(0, allTasks.length);
  await runPool(allTasks, CONCURRENCY, () => {
    done += 1;
    setProgress(done, allTasks.length);
  });

  lastReport = report;
  setProgress(allTasks.length, allTasks.length, `Terminado: ${allTasks.length} comprobaciones en ${report.length} bloques de resultados · ${new Date().toLocaleTimeString()}`);
  renderSummary(report, options);
  renderResults(report);
  ui.run.disabled = false;
  ui.exportBtn.disabled = false;
}

function shareLink() {
  const options = readOptions();
  const paths = options.lines.map((l) => l.trim()).filter(Boolean);
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('paths', paths.join(','));
  OPTIONS.forEach((name) => { if (!options[name]) url.searchParams.set(name, '0'); });
  url.searchParams.set('run', '1');
  const done = () => {
    ui.share.textContent = 'Enlace copiado';
    setTimeout(() => { ui.share.textContent = 'Copiar enlace'; }, 2000);
  };
  const fallback = () => {
    ui.status.hidden = false;
    ui.progressText.textContent = `Enlace: ${url.href}`;
  };
  if (navigator.clipboard) navigator.clipboard.writeText(url.href).then(done, fallback);
  else fallback();
}

function referrerPath(params) {
  const referrer = params.get('referrer');
  if (!referrer) return null;
  try {
    const { pathname, search } = new URL(referrer);
    return `${pathname}${search}`;
  } catch (e) {
    return null;
  }
}

function init() {
  ui.form = document.querySelector('.qa-form');
  ui.textarea = document.getElementById('qa-paths');
  ui.run = document.querySelector('.qa-run');
  ui.exportBtn = document.querySelector('.qa-export');
  ui.share = document.querySelector('.qa-share');
  ui.status = document.querySelector('.qa-status');
  ui.progress = document.querySelector('.qa-progress');
  ui.progressText = document.querySelector('.qa-progress-text');
  ui.summary = document.querySelector('.qa-summary');
  ui.results = document.querySelector('.qa-results');
  ui.pages = document.querySelector('.qa-pages');
  ui.onlyIssues = document.querySelector('.qa-only-issues');

  document.querySelector('.qa-origin').textContent = window.location.host;

  const params = new URLSearchParams(window.location.search);
  const fromSidekick = referrerPath(params);
  if (fromSidekick) {
    // abierto desde el botón QA del Sidekick: audita la página que se está viendo
    document.body.classList.add('qa-embed');
    ui.textarea.value = fromSidekick;
    ui.form.elements.redirects.checked = false;
  } else if (params.has('paths')) {
    ui.textarea.value = params.get('paths').split(',').map((p) => p.trim()).filter(Boolean)
      .join('\n');
  } else {
    ui.textarea.value = storageGet(STORAGE_KEY) || '/';
  }
  OPTIONS.forEach((name) => {
    if (params.get(name) === '0') ui.form.elements[name].checked = false;
    if (params.get(name) === '1') ui.form.elements[name].checked = true;
  });

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    run({ remember: !fromSidekick });
  });
  ui.exportBtn.addEventListener('click', exportCsv);
  ui.share.addEventListener('click', shareLink);
  ui.onlyIssues.addEventListener('change', () => {
    if (lastReport.length) renderResults(lastReport);
  });

  if (fromSidekick || params.get('run') === '1') run({ remember: !fromSidekick });
}

init();
