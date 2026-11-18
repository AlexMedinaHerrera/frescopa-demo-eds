/*
 * Integraciones de terceros activables por entorno.
 *
 * La configuración vive en la hoja de da.live /config/integrations (filas key | value),
 * con claves "<id>.enabled" y "<id>.<campo>". La misma hoja tiene dos versiones:
 *   - aem.page (y localhost) sirven la versión en PREVIEW
 *   - aem.live (y el dominio de producción) sirven la versión PUBLICADA
 * Así se valida una integración en preview sin que llegue a live.
 *
 * Este módulo lo usan el sitio (scripts/delayed.js) y el panel tools/integrations.
 * No importa aem.js para que el panel pueda cargarlo fuera del sitio.
 * La hoja es pública: solo claves públicas, nunca secretos.
 */

export const CONFIG_PATH = '/config/integrations.json';

const GIGYA_HOSTS = { us1: 'cdns.gigya.com', eu1: 'cdns.eu1.gigya.com', au1: 'cdns.au1.gigya.com' };

export const INTEGRATIONS = [
  {
    id: 'gigya',
    name: 'SAP Customer Data Cloud (Gigya)',
    description: 'Login social y registro. Carga el Web SDK con la API key del sitio.',
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
    description: 'Muestra en la página qué integraciones se han cargado y en qué entorno. Pensado para activarlo solo en preview.',
    fields: [],
  },
];

/** Hoja de da.live o JSON de EDS -> { "gigya.enabled": "true", ... } */
export function parseConfig(json) {
  let rows = [];
  if (Array.isArray(json?.data)) rows = json.data;
  else if (json?.[':type'] === 'multi-sheet') rows = json[json[':names']?.[0]]?.data || [];
  return Object.fromEntries(rows
    .filter((row) => row?.key && String(row.key).trim())
    .map(({ key, value }) => [String(key).trim(), String(value ?? '').trim()]));
}

export function getSettings(config, integration) {
  const settings = { enabled: String(config[`${integration.id}.enabled`]).toLowerCase() === 'true' };
  integration.fields.forEach((field) => {
    settings[field.key] = config[`${integration.id}.${field.key}`] || field.default || '';
  });
  return settings;
}

export function missingFields(integration, settings) {
  return integration.fields.filter((field) => field.required && !settings[field.key]);
}

export function getEnvironment(hostname = window.location.hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'local';
  if (hostname.endsWith('.aem.page') || hostname.endsWith('.hlx.page')) return 'preview';
  if (hostname.endsWith('.aem.live') || hostname.endsWith('.hlx.live')) return 'live';
  return 'producción';
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

function showBadge(results) {
  const badge = document.createElement('aside');
  badge.setAttribute('aria-label', 'Integraciones activas');
  badge.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:1000;max-width:320px;padding:10px 14px;'
    + 'border-radius:8px;background:#2c2c2c;color:#fff;font:13px/1.4 sans-serif;box-shadow:0 4px 12px rgb(0 0 0 / 30%)';
  const title = document.createElement('strong');
  title.textContent = `Integraciones · ${getEnvironment()}`;
  badge.append(title);
  const list = document.createElement('ul');
  list.style.cssText = 'margin:6px 0 0;padding-left:18px';
  if (!results.length) results.push({ name: 'ninguna activa', ok: true });
  results.forEach(({ name, ok }) => {
    const item = document.createElement('li');
    item.textContent = `${ok ? '✔' : '✖'} ${name}`;
    list.append(item);
  });
  badge.append(list);
  document.body.append(badge);
}

export async function loadIntegrations() {
  let config;
  try {
    const resp = await fetch(CONFIG_PATH);
    if (!resp.ok) return;
    config = parseConfig(await resp.json());
  } catch {
    return;
  }

  const results = [];
  const scripted = INTEGRATIONS.filter((integration) => integration.src);
  await Promise.all(scripted.map(async (integration) => {
    const settings = getSettings(config, integration);
    if (!settings.enabled || missingFields(integration, settings).length) return;
    try {
      await loadScript(integration.src(settings));
      results.push({ name: integration.name, ok: true });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(`[integrations] ${integration.id}:`, error.message);
      results.push({ name: integration.name, ok: false });
    }
  }));

  if (getSettings(config, { id: 'badge', fields: [] }).enabled) showBadge(results);
}
