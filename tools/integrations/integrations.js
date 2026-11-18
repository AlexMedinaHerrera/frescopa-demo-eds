/*
 * Panel de integraciones por entorno (app de da.live).
 * Abrir en: https://da.live/app/{org}/{site}/tools/integrations
 *
 * Tres versiones de la hoja /config/integrations:
 *   Borrador -> fuente en da.live (lo que editas aquí)
 *   Preview  -> lo que sirve aem.page tras "Aplicar en preview"
 *   Live     -> lo que sirve aem.live y producción tras "Promocionar a live"
 */
/* render() y los manejadores de eventos se llaman entre sí */
/* eslint-disable no-use-before-define */
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  CONFIG_PATH, INTEGRATIONS, parseConfig, getSettings, missingFields,
} from '../../scripts/integrations.js';

const DA_ADMIN = 'https://admin.da.live';
const HLX_ADMIN = 'https://admin.hlx.page';
const SHEET_PATH = CONFIG_PATH.replace(/\.json$/, '');

const ENV_LABELS = { draft: 'Borrador', preview: 'Preview', live: 'Live' };

let ctx;
let token;
const state = {
  saved: {}, draft: {}, preview: null, live: null, busy: false, message: null, draftError: null,
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([name, value]) => {
    if (name === 'class') node.className = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (value === true) node.setAttribute(name, '');
    else if (![false, null, undefined].includes(value)) node.setAttribute(name, value);
  });
  children.flat().forEach((child) => {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  });
  return node;
}

const auth = () => ({ Authorization: `Bearer ${token}` });
const siteUrl = (env) => `https://${ctx.ref}--${ctx.repo}--${ctx.org}.aem.${env === 'live' ? 'live' : 'page'}`;
const sameSettings = (a, b, integration) => JSON.stringify(getSettings(a, integration))
  === JSON.stringify(getSettings(b, integration));

/* ---------- API ---------- */

async function readDraft() {
  const resp = await fetch(`${DA_ADMIN}/source/${ctx.org}/${ctx.repo}${CONFIG_PATH}`, { headers: auth() });
  if (resp.status === 404) return {};
  if (!resp.ok) throw new Error(`da.live respondió ${resp.status} al leer la hoja.`);
  return parseConfig(await resp.json());
}

/** null = la hoja no existe en ese entorno; { error } = no se pudo leer */
async function readEnv(env) {
  try {
    const resp = await fetch(`${siteUrl(env)}${CONFIG_PATH}?ts=${Date.now()}`, { cache: 'no-store' });
    if (resp.status === 404) return null;
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    return { config: parseConfig(await resp.json()) };
  } catch {
    return { error: 'no se pudo leer (¿falta la cabecera CORS para /config/integrations.json?)' };
  }
}

function buildSheet(config) {
  const data = [];
  INTEGRATIONS.forEach((integration) => {
    const settings = getSettings(config, integration);
    data.push({ key: `${integration.id}.enabled`, value: String(settings.enabled) });
    integration.fields.forEach((field) => {
      data.push({ key: `${integration.id}.${field.key}`, value: settings[field.key] });
    });
  });
  // Conserva filas que el panel no conoce (añadidas a mano en la hoja)
  Object.entries(config).forEach(([key, value]) => {
    if (!data.some((row) => row.key === key)) data.push({ key, value });
  });
  return {
    total: data.length, limit: data.length, offset: 0, data, ':type': 'sheet',
  };
}

async function saveDraft() {
  const form = new FormData();
  form.append('data', new Blob([JSON.stringify(buildSheet(state.draft))], { type: 'application/json' }));
  const resp = await fetch(`${DA_ADMIN}/source/${ctx.org}/${ctx.repo}${CONFIG_PATH}`, { method: 'POST', headers: auth(), body: form });
  if (!resp.ok) throw new Error(`No se pudo guardar la hoja en da.live (${resp.status}).`);
}

async function adminAction(action) {
  const resp = await fetch(`${HLX_ADMIN}/${action}/${ctx.org}/${ctx.repo}/${ctx.ref}${CONFIG_PATH}`, { method: 'POST', headers: auth() });
  if (!resp.ok) {
    const detail = resp.headers.get('x-error') || resp.status;
    throw new Error(`${action === 'live' ? 'La publicación' : 'El preview'} falló (${detail}). ¿Tienes permisos de publicación en el sitio?`);
  }
}

/* ---------- Estado ---------- */

const envConfig = (env) => (state[env] && state[env].config) || null;

function pendingPreview() {
  const preview = envConfig('preview');
  if (!preview) return true;
  return INTEGRATIONS.some((integration) => !sameSettings(state.draft, preview, integration));
}

function pendingLive() {
  const preview = envConfig('preview');
  if (!preview) return false;
  const live = envConfig('live');
  if (!live) return true;
  return INTEGRATIONS.some((integration) => !sameSettings(preview, live, integration));
}

function invalidIntegrations() {
  return INTEGRATIONS.filter((integration) => {
    const settings = getSettings(state.draft, integration);
    return settings.enabled && missingFields(integration, settings).length;
  });
}

/* ---------- Render ---------- */

function displayValue(value, isEnabled) {
  if (isEnabled) return value ? 'Activa' : 'Inactiva';
  return value || '—';
}

function envCell(env, integration, fieldKey, compareTo) {
  const config = envConfig(env);
  if (!config) return el('td', { class: 'ip-missing' }, '—');
  const settings = getSettings(config, integration);
  const value = settings[fieldKey];
  const differs = compareTo && JSON.stringify(getSettings(compareTo, integration)[fieldKey])
    !== JSON.stringify(value);
  const classes = [differs ? 'ip-diff' : '', fieldKey === 'enabled' ? `ip-flag ip-${value ? 'on' : 'off'}` : ''].join(' ').trim();
  return el('td', { class: classes || null, title: differs ? 'Distinto del entorno anterior' : null }, displayValue(value, fieldKey === 'enabled'));
}

function draftInput(integration, field) {
  const key = `${integration.id}.${field.key}`;
  const settings = getSettings(state.draft, integration);
  const id = `ip-${integration.id}-${field.key}`;
  const onInput = (event) => { state.draft[key] = event.target.value.trim(); };
  if (field.type === 'select') {
    return el(
      'select',
      { id, onchange: (event) => { onInput(event); render(); } },
      field.options.map((option) => el('option', { value: option, selected: option === settings[field.key] }, option)),
    );
  }
  const missing = settings.enabled && field.required && !settings[field.key];
  return el('input', {
    id,
    type: 'text',
    value: settings[field.key],
    placeholder: field.required ? 'Obligatorio' : '',
    'aria-invalid': missing ? 'true' : null,
    oninput: onInput,
    onchange: render,
  });
}

function integrationStatus(integration) {
  const preview = envConfig('preview');
  const live = envConfig('live');
  if (!preview || !sameSettings(state.draft, preview, integration)) return { cls: 'draft', text: 'Borrador sin aplicar en preview' };
  if (!live || !sameSettings(preview, live, integration)) return { cls: 'validating', text: 'En validación: preview distinto de live' };
  return { cls: 'synced', text: 'Sincronizado en preview y live' };
}

function renderIntegration(integration) {
  const settings = getSettings(state.draft, integration);
  const status = integrationStatus(integration);
  const enabledId = `ip-${integration.id}-enabled`;
  const preview = envConfig('preview');

  const rows = [
    el(
      'tr',
      {},
      el('th', { scope: 'row' }, el('label', { for: enabledId }, 'Activa')),
      el('td', {}, el('input', {
        id: enabledId,
        type: 'checkbox',
        class: 'ip-switch',
        checked: settings.enabled,
        onchange: (event) => { state.draft[`${integration.id}.enabled`] = String(event.target.checked); render(); },
      })),
      envCell('preview', integration, 'enabled', state.draft),
      envCell('live', integration, 'enabled', preview),
    ),
    ...integration.fields.map((field) => el(
      'tr',
      {},
      el('th', { scope: 'row' }, el('label', { for: `ip-${integration.id}-${field.key}` }, field.label)),
      el('td', {}, draftInput(integration, field)),
      envCell('preview', integration, field.key, state.draft),
      envCell('live', integration, field.key, preview),
    )),
  ];

  return el(
    'section',
    { class: 'ip-card' },
    el(
      'header',
      { class: 'ip-card-head' },
      el('div', {}, el('h2', {}, integration.name), el('p', {}, integration.description)),
      el('span', { class: `ip-status ip-status-${status.cls}` }, status.text),
    ),
    el(
      'table',
      { class: 'ip-table' },
      el('thead', {}, el(
        'tr',
        {},
        el('th', { scope: 'col' }, 'Campo'),
        ['draft', 'preview', 'live'].map((env) => el('th', { scope: 'col' }, ENV_LABELS[env])),
      )),
      el('tbody', {}, rows),
    ),
  );
}

function envNote(env) {
  const value = state[env];
  if (value === null) return 'la hoja aún no existe aquí';
  if (value && value.error) return value.error;
  return 'leído ahora';
}

async function run(task, success) {
  state.busy = true;
  state.message = null;
  render();
  try {
    await task();
    state.message = { type: 'ok', text: success };
  } catch (error) {
    state.message = { type: 'error', text: error.message };
  }
  state.busy = false;
  await reload(false);
}

async function applyToPreview() {
  const invalid = invalidIntegrations();
  if (invalid.length) {
    state.message = { type: 'error', text: `Faltan campos obligatorios en: ${invalid.map((i) => i.name).join(', ')}.` };
    render();
    return;
  }
  await run(async () => {
    await saveDraft();
    await adminAction('preview');
  }, 'Aplicado en preview. Valídalo en aem.page antes de promocionarlo.');
}

async function promoteToLive() {
  // eslint-disable-next-line no-alert
  if (!window.confirm('Se publicará en live (aem.live y producción) la configuración que está ahora en preview. ¿Continuar?')) return;
  await run(() => adminAction('live'), 'Publicado en live.');
}

function render() {
  const app = document.getElementById('app');
  const canPreview = !state.busy && !state.draftError && pendingPreview();
  const canLive = !state.busy && !pendingPreview() && pendingLive();

  app.replaceChildren(
    el(
      'header',
      { class: 'ip-head' },
      el('div', {}, el('h1', {}, 'Integraciones por entorno'), el('p', { class: 'ip-site' }, `${ctx.org}/${ctx.repo} · rama ${ctx.ref}`)),
      el(
        'div',
        { class: 'ip-actions' },
        el('button', {
          type: 'button', class: 'ip-btn', disabled: state.busy, onclick: () => reload(true),
        }, 'Recargar'),
        el('button', {
          type: 'button', class: 'ip-btn ip-btn-primary', disabled: !canPreview, onclick: applyToPreview,
        }, 'Aplicar en preview'),
        el('button', {
          type: 'button', class: 'ip-btn ip-btn-live', disabled: !canLive, onclick: promoteToLive,
        }, 'Promocionar a live'),
      ),
    ),
    el(
      'p',
      { class: `ip-message ${state.message ? `ip-message-${state.message.type}` : ''}`, role: 'status', 'aria-live': 'polite' },
      state.busy ? 'Trabajando…' : (state.message && state.message.text) || '',
    ),
    el(
      'ol',
      { class: 'ip-flow' },
      el('li', {}, el('strong', {}, 'Borrador'), ' Edita la columna Borrador.'),
      el('li', {}, el('strong', {}, 'Preview'), ' Aplica y valida en ', el('a', { href: siteUrl('preview'), target: '_blank', rel: 'noopener' }, 'aem.page'), ` (${envNote('preview')}).`),
      el('li', {}, el('strong', {}, 'Live'), ' Promociona a ', el('a', { href: siteUrl('live'), target: '_blank', rel: 'noopener' }, 'aem.live'), ` y producción (${envNote('live')}).`),
    ),
    ...INTEGRATIONS.map(renderIntegration),
    el(
      'footer',
      { class: 'ip-foot' },
      el('p', {}, 'La hoja es pública: pon solo claves públicas (p. ej. la API key de Gigya), nunca secretos. '),
      el('p', {}, el('a', { href: `https://da.live/sheet#/${ctx.org}/${ctx.repo}${SHEET_PATH}`, target: '_blank', rel: 'noopener' }, `Abrir la hoja ${SHEET_PATH} en da.live`)),
    ),
  );
}

async function reload(clearMessage = true) {
  if (clearMessage) state.message = null;
  state.busy = true;
  render();
  const [saved, preview, live] = await Promise.allSettled([readDraft(), readEnv('preview'), readEnv('live')]);
  state.preview = preview.value ?? { error: 'no se pudo leer' };
  state.live = live.value ?? { error: 'no se pudo leer' };
  if (saved.status === 'fulfilled') {
    state.draftError = null;
    state.saved = saved.value;
    state.draft = { ...saved.value };
  } else {
    // Sin borrador no se escribe nada: se sobrescribiría la hoja con valores por defecto
    state.draftError = saved.reason.message;
    state.message = { type: 'error', text: `${saved.reason.message} No se puede editar hasta recargar con éxito.` };
  }
  state.busy = false;
  render();
}

(async function init() {
  const sdk = await DA_SDK;
  ({ token } = sdk);
  ctx = { ...sdk.context, ref: sdk.context.ref || 'main' };
  await reload();
}());
