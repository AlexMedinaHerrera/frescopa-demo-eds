/*
 * Panel QA (app de da.live): comprueba enlaces e imágenes rotas en una lista de rutas.
 * Abrir en: https://da.live/app/{org}/{site}/tools/qa  (otra rama: ?ref={rama})
 * o directamente en https://{rama}--{site}--{org}.aem.page/tools/qa.html
 *
 * Solo puede leer estados HTTP del mismo origen (aem.page no envía CORS),
 * así que valida la rama desde la que se sirve el panel.
 */

const STORAGE_KEY = 'qa-panel-paths';
const CONCURRENCY = 6;
const TIMEOUT_MS = 15000;
const SKIP_PROTOCOLS = ['mailto:', 'tel:', 'javascript:', 'data:', 'blob:', 'sms:']; // eslint-disable-line no-script-url

/* estados: ok | error | warn | info */
const LABELS = {
  ok: 'OK',
  error: 'Roto',
  warn: 'Aviso',
  info: 'Sin verificar',
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
      return { status: 'warn', code: res.status, message: `Redirige a ${res.url}` };
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
  const key = `${kind}|${url}`;
  if (cache.has(key)) return cache.get(key);
  const sameOrigin = new URL(url).origin === window.location.origin;
  let promise;
  if (sameOrigin) promise = checkSameOrigin(url);
  else if (kind === 'imagen') promise = checkExternalImage(url);
  else if (checkExternal) promise = checkExternalLink(url);
  else promise = Promise.resolve({ status: 'info', code: null, message: 'Externo (omitido)' });
  cache.set(key, promise);
  return promise;
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

/* ---------- extracción ---------- */

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
    if (!value) {
      issues.push({
        kind, url: '(vacío)', status: kind === 'imagen' ? 'error' : 'warn', message: `${kind === 'imagen' ? 'Imagen' : 'Enlace'} sin URL`, context,
      });
      return;
    }
    if (value.startsWith('#')) {
      if (value === '#') {
        issues.push({
          kind, url: value, status: 'warn', message: 'Enlace a "#" sin destino', context,
        });
      }
      return;
    }
    if (shouldSkip(value)) return;
    let url;
    try {
      url = new URL(value, baseUrl);
    } catch (e) {
      issues.push({
        kind, url: value, status: 'error', message: 'URL mal formada', context,
      });
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
    // en EDS el <img> es el fallback; validamos su src y, si es distinto, el primer <source>
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

/* ---------- auditoría ---------- */

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
  const { items, issues } = extractTargets(loaded.doc, loaded.finalUrl || source.url, source.scope);
  entry.rows.push(...issues);
  entry.doc = loaded.doc;
  const tasks = items.map((item) => async () => {
    const result = await checkUrl(item.url, item.kind, options.external);
    entry.rows.push({ ...item, ...result });
  });
  return { entry, tasks };
}

function fragmentPath(doc, name) {
  const meta = doc && doc.querySelector(`meta[name="${name}"]`);
  const value = meta ? meta.getAttribute('content') : `/${name}`;
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return url.pathname.replace(/(\.plain)?\.html$/, '');
  } catch (e) {
    return null;
  }
}

/* ---------- interfaz ---------- */

/* {rama}--{repo}--{org}.aem.page -> https://da.live/edit#/{org}/{repo}{ruta} */
const SITE = (() => {
  const [ref, repo, org] = window.location.hostname.split('.')[0].split('--');
  return org ? { ref, repo, org } : null;
})();

function daEditUrl(path) {
  if (!SITE || !path) return null;
  const docPath = path.endsWith('/') ? `${path}index` : path;
  return `https://da.live/edit#/${SITE.org}/${SITE.repo}${docPath}`;
}

const ui = {};

function rowSort(a, b) {
  const order = {
    error: 0, warn: 1, info: 2, ok: 3,
  };
  return order[a.status] - order[b.status] || a.kind.localeCompare(b.kind);
}

function pageStatus(entry) {
  if (entry.status === 'error' || entry.rows.some((r) => r.status === 'error')) return 'error';
  if (entry.rows.some((r) => r.status === 'warn')) return 'warn';
  return 'ok';
}

function renderSummary(report) {
  const rows = report.flatMap((e) => e.rows);
  const count = (fn) => rows.filter(fn).length;
  const brokenPages = report.filter((e) => e.status === 'error').length;
  const stats = [
    ['Páginas', report.length, brokenPages ? 'error' : 'ok', brokenPages ? `${brokenPages} no cargan` : 'todas cargan'],
    ['Enlaces rotos', count((r) => r.kind === 'enlace' && r.status === 'error'), null, `de ${count((r) => r.kind === 'enlace')} enlaces`],
    ['Imágenes rotas', count((r) => r.kind === 'imagen' && r.status === 'error'), null, `de ${count((r) => r.kind === 'imagen')} imágenes`],
    ['Avisos', count((r) => r.status === 'warn'), 'warn', 'redirecciones, enlaces vacíos'],
  ];
  ui.summary.replaceChildren(...stats.map(([label, value, tone, sub]) => {
    let t = tone;
    if (!t) t = value ? 'error' : 'ok';
    if (tone === 'warn' && !value) t = 'ok';
    return el(
      'div',
      { class: `qa-stat qa-${t}` },
      el('span', { class: 'qa-stat-value' }, value),
      el('span', { class: 'qa-stat-label' }, label),
      el('span', { class: 'qa-stat-sub' }, sub),
    );
  }));
  ui.summary.hidden = false;
}

function renderResults(report) {
  const onlyIssues = ui.onlyIssues.checked;
  const pages = report.map((entry) => {
    const status = pageStatus(entry);
    const rows = entry.rows
      .filter((r) => !onlyIssues || r.status === 'error' || r.status === 'warn')
      .sort(rowSort);
    const problems = entry.rows.filter((r) => r.status === 'error' || r.status === 'warn').length;
    const body = [];
    if (entry.message) body.push(el('p', { class: 'qa-page-error' }, entry.message));
    if (rows.length) {
      body.push(el(
        'div',
        { class: 'qa-table-wrap' },
        el(
          'table',
          { class: 'qa-table' },
          el('thead', {}, el('tr', {}, ['Estado', 'Tipo', 'URL', 'Detalle', 'Texto / alt'].map((h) => el('th', { scope: 'col' }, h)))),
          el('tbody', {}, rows.map((r) => el(
            'tr',
            { class: `qa-row-${r.status}` },
            el('td', {}, el('span', { class: `qa-badge qa-${r.status}` }, LABELS[r.status])),
            el('td', {}, r.kind),
            el('td', { class: 'qa-url' }, r.url.startsWith('http') ? el('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.url.replace(window.location.origin, '')) : r.url),
            el('td', {}, r.message),
            el('td', { class: 'qa-context' }, r.context || ''),
          ))),
        ),
      ));
    } else if (!entry.message) {
      body.push(el('p', { class: 'qa-empty' }, onlyIssues ? 'Sin problemas.' : 'No hay enlaces ni imágenes.'));
    }
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
          daEditUrl(entry.path) ? el('a', { href: daEditUrl(entry.path), target: '_blank', rel: 'noopener' }, 'editar en da.live ↗') : null,
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
  const header = ['pagina', 'estado', 'tipo', 'url', 'detalle', 'texto_alt'];
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
  return {
    lines: (data.get('paths') || '').split('\n'),
    fragments: data.get('fragments') === 'on',
    external: data.get('external') === 'on',
  };
}

async function run() {
  const options = readOptions();
  storageSet(STORAGE_KEY, ui.textarea.value);
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

  if (!sources.length && !report.length) {
    ui.textarea.focus();
    return;
  }

  ui.run.disabled = true;
  ui.exportBtn.disabled = true;
  ui.status.hidden = false;
  setProgress(0, sources.length, 'Cargando páginas…');

  const audited = await Promise.all(sources.map((s) => auditSource(s, options)));
  const allTasks = [];
  audited.forEach(({ entry, tasks }) => {
    report.push(entry);
    allTasks.push(...tasks);
  });

  if (options.fragments) {
    const fragPaths = new Set();
    audited.forEach(({ entry }) => {
      ['nav', 'footer'].forEach((name) => {
        const p = fragmentPath(entry.doc, name);
        if (p) fragPaths.add(p);
      });
    });
    if (!audited.length) {
      fragPaths.add('/nav');
      fragPaths.add('/footer');
    }
    const fragAudits = await Promise.all([...fragPaths].map((p) => auditSource({
      title: `${p} (fragmento)`,
      path: p,
      url: new URL(`${p}.plain.html`, window.location.origin).href,
      scope: 'body',
    }, options)));
    fragAudits.forEach(({ entry, tasks }) => {
      report.push(entry);
      allTasks.push(...tasks);
    });
  }

  report.forEach((e) => { delete e.doc; });

  let done = 0;
  setProgress(0, allTasks.length);
  await runPool(allTasks, CONCURRENCY, () => {
    done += 1;
    setProgress(done, allTasks.length);
  });

  lastReport = report;
  setProgress(allTasks.length, allTasks.length, `Terminado: ${allTasks.length} comprobaciones en ${report.length} páginas · ${new Date().toLocaleTimeString()}`);
  renderSummary(report);
  renderResults(report);
  ui.run.disabled = false;
  ui.exportBtn.disabled = false;
}

function shareLink() {
  const { lines, fragments, external } = readOptions();
  const paths = lines.map((l) => l.trim()).filter(Boolean);
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('paths', paths.join(','));
  if (!fragments) url.searchParams.set('fragments', '0');
  if (!external) url.searchParams.set('external', '0');
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
  if (params.has('paths')) {
    ui.textarea.value = params.get('paths').split(',').map((p) => p.trim()).filter(Boolean)
      .join('\n');
  } else {
    ui.textarea.value = storageGet(STORAGE_KEY) || '/';
  }
  if (params.get('fragments') === '0') ui.form.elements.fragments.checked = false;
  if (params.get('external') === '0') ui.form.elements.external.checked = false;

  ui.form.addEventListener('submit', (e) => {
    e.preventDefault();
    run();
  });
  ui.exportBtn.addEventListener('click', exportCsv);
  ui.share.addEventListener('click', shareLink);
  ui.onlyIssues.addEventListener('change', () => { if (lastReport.length) renderResults(lastReport); });

  if (params.get('run') === '1') run();
}

init();
