/*
 * Integraciones de terceros por entorno.
 *
 * Entorno = rama de Git, como los run modes de AEM:
 *   develop--<site>--<org>.aem.page  -> columna "develop"
 *   stage--<site>--<org>.aem.page    -> columna "stage"
 *   main--<site>--<org>.aem.page     -> columna "main" (pre-producción)
 *   dominio de producción / aem.live -> columna "main"
 *   ramas no listadas (feature) y localhost -> columna "develop"
 *
 * Cada integración tiene su propia hoja en da.live (/config/integrations/<id>)
 * con filas "key" y una columna por entorno. Una hoja por integración permite
 * dar permisos de edición distintos (p. ej. CRM solo Salesforce) y publicar
 * cada integración por separado.
 *
 * Producción lee la versión PUBLICADA de la hoja; el resto de entornos se ven
 * en aem.page y leen la versión en PREVIEW. Así, un cambio en la columna "main"
 * no llega a producción hasta que alguien con rol de publicación lo publica.
 *
 * Lo usan el sitio (scripts/delayed.js) y el panel tools/integrations.
 * No importa aem.js para que el panel pueda cargarlo fuera del sitio.
 * Las hojas son públicas: solo claves públicas, nunca secretos.
 */

export const CONFIG_FOLDER = '/config/integrations';
export const configPath = (id) => `${CONFIG_FOLDER}/${id}.json`;

export const ENVIRONMENTS = [
  { id: 'develop', label: 'Desarrollo' },
  { id: 'stage', label: 'Stage' },
  { id: 'main', label: 'Producción' },
];
export const DEFAULT_ENV = 'develop';
export const PROD_ENV = 'main';

const GIGYA_HOSTS = { us1: 'cdns.gigya.com', eu1: 'cdns.eu1.gigya.com', au1: 'cdns.au1.gigya.com' };

export const PATH_FIELDS = [
  {
    key: 'include', label: 'Solo en rutas', type: 'text', placeholder: 'Todas (p. ej. /account/**)',
  },
  {
    key: 'exclude', label: 'Excepto rutas', type: 'text', placeholder: 'Ninguna (p. ej. /es/legal/**)',
  },
];

export const INTEGRATIONS = [
  {
    id: 'gigya',
    name: 'SAP Customer Data Cloud (Gigya)',
    description: 'Login social y registro. Carga el Web SDK con la API key de cada entorno.',
    fields: [
      {
        key: 'apikey', label: 'API key', type: 'text', required: true,
      },
      {
        key: 'datacenter', label: 'Data center', type: 'select', options: Object.keys(GIGYA_HOSTS), default: 'eu1',
      },
    ],
    src: ({ apikey, datacenter }) => `https://${GIGYA_HOSTS[datacenter] || GIGYA_HOSTS.eu1}/js/gigya.js?apikey=${encodeURIComponent(apikey)}`,
  },
  {
    id: 'salesforce',
    name: 'Salesforce Marketing Cloud Personalization',
    description: 'Beacon de personalización y tracking (antes Interaction Studio / Evergage).',
    fields: [
      {
        key: 'account', label: 'Account', type: 'text', required: true,
      },
      {
        key: 'dataset', label: 'Dataset', type: 'text', required: true,
      },
    ],
    src: ({ account, dataset }) => `https://cdn.evgnet.com/beacon/${encodeURIComponent(account)}/${encodeURIComponent(dataset)}/scripts/evergage.min.js`,
  },
  {
    id: 'badge',
    name: 'Distintivo de validación',
    description: 'Muestra en la página el entorno y las integraciones cargadas. Útil en desarrollo y stage.',
    fields: [],
  },
];

export const allFields = (integration) => [...integration.fields, ...PATH_FIELDS];

/** Hoja de da.live o JSON de EDS -> { enabled: { develop: 'true', stage: '', main: '' }, ... } */
export function parseSheet(json) {
  let rows = [];
  if (Array.isArray(json?.data)) rows = json.data;
  else if (json?.[':type'] === 'multi-sheet') rows = json[json[':names']?.[0]]?.data || [];
  const config = {};
  rows.forEach((row) => {
    const key = String(row?.key ?? '').trim();
    if (!key) return;
    config[key] = Object.fromEntries(ENVIRONMENTS.map(({ id }) => [id, String(row[id] ?? '').trim()]));
  });
  return config;
}

export function getSettings(config, integration, env) {
  const value = (key) => (config && config[key] && config[key][env]) || '';
  const settings = { enabled: value('enabled').toLowerCase() === 'true' };
  allFields(integration).forEach((field) => {
    settings[field.key] = value(field.key) || field.default || '';
  });
  return settings;
}

export function missingFields(integration, settings) {
  return integration.fields.filter((field) => field.required && !settings[field.key]);
}

export function getEnvironment(hostname = window.location.hostname) {
  const match = hostname.match(/^([a-z0-9-]+?)--[a-z0-9-]+--[a-z0-9-]+\.(?:aem|hlx)\.(?:page|live)$/i);
  if (match) {
    const branch = match[1].toLowerCase();
    return ENVIRONMENTS.some(({ id }) => id === branch) ? branch : DEFAULT_ENV;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') return DEFAULT_ENV;
  return PROD_ENV;
}

export function getTier(hostname = window.location.hostname) {
  return /\.(?:aem|hlx)\.page$/.test(hostname) || hostname === 'localhost' ? 'preview' : 'live';
}

/* "/es/**" cubre /es y todo lo que cuelga; "*" no cruza "/" */
function globToRegExp(glob) {
  const source = glob.trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .split('/**').join('<DS>')
    .split('**')
    .join('<D>')
    .split('*')
    .join('[^/]*')
    .split('<DS>')
    .join('(?:/.*)?')
    .split('<D>')
    .join('.*');
  return new RegExp(`^${source}$`);
}

const toList = (value) => String(value || '').split(',').map((item) => item.trim()).filter(Boolean);

export function matchesPath(settings, pathname = window.location.pathname) {
  const hit = (globs) => globs.some((glob) => globToRegExp(glob).test(pathname));
  const include = toList(settings.include);
  return (!include.length || hit(include)) && !hit(toList(settings.exclude));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${CSS.escape(src)}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.append(script);
  });
}

function showBadge(results, env) {
  const { label } = ENVIRONMENTS.find(({ id }) => id === env);
  const badge = document.createElement('aside');
  badge.setAttribute('aria-label', 'Integraciones activas');
  badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:1000;max-width:320px;padding:10px 14px;'
    + 'border-radius:8px;background:#2c2c2c;color:#fff;font:13px/1.4 sans-serif;box-shadow:0 4px 12px rgb(0 0 0 / 30%)';
  const title = document.createElement('strong');
  title.textContent = `${label} (${env}) · ${getTier()}`;
  badge.append(title);
  const list = document.createElement('ul');
  list.style.cssText = 'margin:6px 0 0;padding-left:18px;color:#fff';
  if (!results.length) results.push({ name: 'Ningún script de terceros activo' });
  results.forEach(({ name, ok }) => {
    const item = document.createElement('li');
    item.style.cssText = 'color:#fff;font:inherit;margin:0';
    item.textContent = ok === undefined ? name : `${ok ? '✔' : '✖'} ${name}`;
    list.append(item);
  });
  badge.append(list);
  document.body.append(badge);
}

async function readSheet(id) {
  try {
    const resp = await fetch(configPath(id));
    return resp.ok ? parseSheet(await resp.json()) : null;
  } catch {
    return null;
  }
}

export async function loadIntegrations() {
  const env = getEnvironment();
  const active = (await Promise.all(INTEGRATIONS.map(async (integration) => {
    const settings = getSettings(await readSheet(integration.id), integration, env);
    const complete = !missingFields(integration, settings).length;
    const ready = settings.enabled && complete && matchesPath(settings);
    return ready ? { integration, settings } : null;
  }))).filter(Boolean);

  const results = [];
  await Promise.all(active.filter(({ integration }) => integration.src)
    .map(async ({ integration, settings }) => {
      try {
        await loadScript(integration.src(settings));
        results.push({ name: integration.name, ok: true });
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`[integrations] ${integration.id}:`, error.message);
        results.push({ name: integration.name, ok: false });
      }
    }));

  if (active.some(({ integration }) => integration.id === 'badge')) showBadge(results, env);
}
