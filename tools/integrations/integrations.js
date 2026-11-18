/*
 * Panel de integraciones por entorno (app de da.live).
 * Abrir en: https://da.live/app/{org}/{site}/tools/integrations
 *
 * Una tarjeta por integración (una hoja por integración en /config/integrations/<id>)
 * con una columna por entorno (rama): develop, stage y main.
 *   Aplicar     -> guarda la hoja y hace preview: afecta a develop, stage y pre-producción
 *   Publicar    -> publica la hoja: la columna "main" llega a producción
 * Los permisos los aplican da.live (editar) y AEM (preview / publicar); el panel solo
 * los refleja desactivando botones.
 */
/* render() y los manejadores de eventos se llaman entre sí */
/* eslint-disable no-use-before-define */
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  CONFIG_FOLDER, ENVIRONMENTS, INTEGRATIONS, PROD_ENV,
  allFields, configPath, getSettings, missingFields, parseSheet,
} from '../../scripts/integrations.js';

const DA_ADMIN = 'https://admin.da.live';
const HLX_ADMIN = 'https://admin.hlx.page';

let ctx;
let token;
let busy = false;
let message = null;
const sheets = {};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([name, value]) => {
    if (name === 'class') node.className = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (value === true) node.setAttribute(name, '');
    else if (![false, null, undefined].includes(value)) node.setAttribute(name, value);
  });
  children.flat().forEach((child) => {
    if (![false, null, undefined].includes(child)) node.append(child);
  });
  return node;
}

const auth = () => ({ Authorization: `Bearer ${token}` });
const siteUrl = (branch, tier = 'page') => `https://${branch}--${ctx.repo}--${ctx.org}.aem.${tier}`;
const settingsOf = (config, integration, env) => getSettings(config || {}, integration, env);
const sameEnv = (a, b, integration, env) => JSON.stringify(settingsOf(a, integration, env))
  === JSON.stringify(settingsOf(b, integration, env));
const sameSheet = (a, b, integration) => ENVIRONMENTS
  .every(({ id }) => sameEnv(a, b, integration, id));

/* ---------- API ---------- */

async function readDraft(id) {
  const resp = await fetch(`${DA_ADMIN}/source/${ctx.org}/${ctx.repo}${configPath(id)}`, { headers: auth() });
  const actions = resp.headers.get('x-da-actions');
  const canEdit = actions ? actions.split('=').pop().split(',').includes('write') : true;
  if (resp.status === 404) return { config: {}, canEdit };
  if (!resp.ok) throw new Error(`da.live respondió ${resp.status}`);
  return { config: parseSheet(await resp.json()), canEdit };
}

/** null = no existe en ese nivel; { error } = no se pudo leer */
async function readTier(id, tier) {
  try {
    const resp = await fetch(`${siteUrl(ctx.ref, tier)}${configPath(id)}?ts=${Date.now()}`, { cache: 'no-store' });
    if (resp.status === 404) return null;
    if (!resp.ok) return { error: `HTTP ${resp.status}` };
    return { config: parseSheet(await resp.json()) };
  } catch {
    return { error: 'no se pudo leer (¿falta la cabecera CORS?)' };
  }
}

async function readPermissions(id) {
  try {
    const resp = await fetch(`${HLX_ADMIN}/status/${ctx.org}/${ctx.repo}/${ctx.ref}${configPath(id)}`, { headers: auth() });
    if (!resp.ok) return { canPreview: false, canPublish: false };
    const status = await resp.json();
    const can = (partition) => (status[partition]?.permissions || []).includes('write');
    return { canPreview: can('preview'), canPublish: can('live') };
  } catch {
    return { canPreview: false, canPublish: false };
  }
}

function buildSheet(integration, config) {
  const keys = ['enabled', ...allFields(integration).map((field) => field.key)];
  Object.keys(config).forEach((key) => { if (!keys.includes(key)) keys.push(key); });
  const data = keys.map((key) => {
    const row = { key };
    ENVIRONMENTS.forEach(({ id }) => {
      if (key === 'enabled') row[id] = String(settingsOf(config, integration, id).enabled);
      else row[id] = config[key]?.[id] ?? '';
    });
    return row;
  });
  return {
    total: data.length, limit: data.length, offset: 0, data, ':type': 'sheet',
  };
}

async function saveDraft(integration) {
  const form = new FormData();
  const body = JSON.stringify(buildSheet(integration, sheets[integration.id].draft));
  form.append('data', new Blob([body], { type: 'application/json' }));
  const resp = await fetch(`${DA_ADMIN}/source/${ctx.org}/${ctx.repo}${configPath(integration.id)}`, { method: 'POST', headers: auth(), body: form });
  if (resp.status === 401 || resp.status === 403) throw new Error('da.live no te permite editar esta integración.');
  if (!resp.ok) throw new Error(`No se pudo guardar en da.live (${resp.status}).`);
}

async function adminAction(action, integration) {
  const resp = await fetch(`${HLX_ADMIN}/${action}/${ctx.org}/${ctx.repo}/${ctx.ref}${configPath(integration.id)}`, { method: 'POST', headers: auth() });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Tu rol en el sitio no permite ${action === 'live' ? 'publicar' : 'hacer preview'}.`);
  }
  if (!resp.ok) throw new Error(`${action === 'live' ? 'La publicación' : 'El preview'} falló (${resp.headers.get('x-error') || resp.status}).`);
}

/* ---------- Acciones ---------- */

async function run(task, success) {
  busy = true;
  message = null;
  render();
  try {
    await task();
    message = { type: 'ok', text: success };
  } catch (error) {
    message = { type: 'error', text: error.message };
  }
  await reload(false);
}

async function apply(integration) {
  const { draft } = sheets[integration.id];
  const invalid = ENVIRONMENTS.filter(({ id }) => {
    const settings = settingsOf(draft, integration, id);
    return settings.enabled && missingFields(integration, settings).length;
  });
  if (invalid.length) {
    message = { type: 'error', text: `${integration.name}: faltan campos obligatorios en ${invalid.map((env) => env.label).join(', ')}.` };
    render();
    return;
  }
  await run(async () => {
    await saveDraft(integration);
    await adminAction('preview', integration);
  }, `${integration.name}: aplicado en desarrollo, stage y pre-producción.`);
}

async function publish(integration) {
  // eslint-disable-next-line no-alert
  if (!window.confirm(`Se publicará la configuración de ${integration.name}. La columna Producción llegará al sitio público. ¿Continuar?`)) return;
  await run(() => adminAction('live', integration), `${integration.name}: publicado en producción.`);
}

/* ---------- Render ---------- */

function display(value, isFlag) {
  if (isFlag) return value ? 'Activa' : 'Inactiva';
  return value || '(vacío)';
}

function fieldControl(integration, field, env, sheet) {
  const isFlag = field.key === 'enabled';
  const id = `ip-${integration.id}-${field.key}-${env}`;
  const settings = settingsOf(sheet.draft, integration, env);
  const disabled = !sheet.canEdit || busy;
  const update = (value) => {
    sheet.draft[field.key] = { ...(sheet.draft[field.key] || {}), [env]: value };
  };

  let control;
  if (isFlag) {
    control = el('input', {
      id,
      type: 'checkbox',
      class: 'ip-switch',
      checked: settings.enabled,
      disabled,
      onchange: (event) => { update(String(event.target.checked)); render(); },
    });
  } else if (field.type === 'select') {
    control = el('select', {
      id, disabled, onchange: (event) => { update(event.target.value); render(); },
    }, field.options.map((option) => el('option', { value: option, selected: option === settings[field.key] }, option)));
  } else {
    control = el('input', {
      id,
      type: 'text',
      value: settings[field.key],
      placeholder: field.placeholder || (field.required ? 'Obligatorio' : ''),
      disabled,
      'aria-invalid': settings.enabled && field.required && !settings[field.key] ? 'true' : null,
      oninput: (event) => update(event.target.value.trim()),
      onchange: render,
    });
  }

  // Indicadores por celda: borrador vs preview y, en producción, preview vs live
  const key = isFlag ? 'enabled' : field.key;
  const draftValue = settings[key];
  const previewValue = settingsOf(sheet.preview?.config, integration, env)[key];
  const liveValue = settingsOf(sheet.live?.config, integration, env)[key];
  let note = null;
  if (JSON.stringify(draftValue) !== JSON.stringify(previewValue)) {
    note = el('span', { class: 'ip-note ip-note-draft' }, 'sin aplicar');
  } else if (env === PROD_ENV && JSON.stringify(previewValue) !== JSON.stringify(liveValue)) {
    note = el('span', { class: 'ip-note ip-note-live' }, `en producción: ${display(liveValue, isFlag)}`);
  }
  return el('td', { class: note ? 'ip-changed' : null }, control, note);
}

function cardStatus(integration, sheet) {
  if (!sheet.preview?.config || !sameSheet(sheet.draft, sheet.preview.config, integration)) {
    return { cls: 'draft', text: 'Cambios sin aplicar' };
  }
  const liveConfig = sheet.live?.config;
  if (!liveConfig || !sameEnv(sheet.preview.config, liveConfig, integration, PROD_ENV)) {
    return { cls: 'validating', text: 'Producción pendiente de publicar' };
  }
  return { cls: 'synced', text: 'Producción al día' };
}

function permissionChip(label, allowed) {
  return el('span', { class: `ip-perm ${allowed ? 'ip-perm-yes' : 'ip-perm-no'}` }, `${allowed ? '✔' : '✖'} ${label}`);
}

function renderIntegration(integration) {
  const sheet = sheets[integration.id];
  if (!sheet) return null;
  if (sheet.error) {
    return el('section', { class: 'ip-card' }, el('h2', {}, integration.name), el('p', { class: 'ip-message-error' }, sheet.error));
  }
  const status = cardStatus(integration, sheet);
  const previewConfig = sheet.preview?.config;
  const applied = previewConfig && sameSheet(sheet.draft, previewConfig, integration);
  const published = sheet.live?.config && sheet.preview?.config
    && sameSheet(sheet.preview.config, sheet.live.config, integration);

  let applyReason = null;
  if (!sheet.canEdit) applyReason = 'No tienes permiso de edición en da.live para esta integración.';
  else if (!sheet.canPreview) applyReason = 'Tu rol en el sitio no permite hacer preview.';
  else if (applied) applyReason = 'No hay cambios que aplicar.';

  let publishReason = null;
  if (!sheet.canPublish) publishReason = 'Tu rol en el sitio no permite publicar (necesitas rol publish o admin).';
  else if (!applied) publishReason = 'Aplica primero los cambios y valídalos en pre-producción.';
  else if (published) publishReason = 'Producción ya está al día.';

  const rows = [{ key: 'enabled', label: 'Activa' }, ...allFields(integration)].map((field) => el(
    'tr',
    { class: ['include', 'exclude'].includes(field.key) ? 'ip-row-paths' : null },
    el('th', { scope: 'row' }, el('label', { for: `ip-${integration.id}-${field.key}-${ENVIRONMENTS[0].id}` }, field.label)),
    ENVIRONMENTS.map(({ id }) => fieldControl(integration, field, id, sheet)),
  ));

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
      'p',
      { class: 'ip-perms' },
      'Tus permisos: ',
      permissionChip('editar', sheet.canEdit),
      permissionChip('aplicar', sheet.canPreview),
      permissionChip('publicar', sheet.canPublish),
    ),
    el(
      'div',
      { class: 'ip-table-wrap' },
      el(
        'table',
        { class: 'ip-table' },
        el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Campo'), ENVIRONMENTS.map((env) => el('th', { scope: 'col' }, `${env.label}`, el('small', {}, `rama ${env.id}`))))),
        el('tbody', {}, rows),
      ),
    ),
    el(
      'div',
      { class: 'ip-card-actions' },
      el('button', {
        type: 'button', class: 'ip-btn ip-btn-primary', disabled: busy || !!applyReason, title: applyReason, onclick: () => apply(integration),
      }, 'Aplicar'),
      el('button', {
        type: 'button', class: 'ip-btn ip-btn-live', disabled: busy || !!publishReason, title: publishReason, onclick: () => publish(integration),
      }, 'Publicar en producción'),
      el('span', { class: 'ip-hint' }, applyReason || publishReason || ''),
    ),
  );
}

function render() {
  const app = document.getElementById('app');
  const envLinks = [
    ...ENVIRONMENTS.map((env) => el('a', { href: siteUrl(env.id), target: '_blank', rel: 'noopener' }, env.id === PROD_ENV ? 'Pre-producción (main)' : `${env.label} (${env.id})`)),
    el('a', { href: siteUrl(PROD_ENV, 'live'), target: '_blank', rel: 'noopener' }, 'Producción (aem.live)'),
  ];

  app.replaceChildren(
    el(
      'header',
      { class: 'ip-head' },
      el('div', {}, el('h1', {}, 'Integraciones por entorno'), el('p', { class: 'ip-site' }, `${ctx.org}/${ctx.repo}`)),
      el('button', {
        type: 'button', class: 'ip-btn', disabled: busy, onclick: () => reload(true),
      }, 'Recargar'),
    ),
    el('nav', { class: 'ip-envs', 'aria-label': 'Entornos' }, 'Abrir: ', envLinks),
    el(
      'p',
      { class: `ip-message ${message ? `ip-message-${message.type}` : ''}`, role: 'status', 'aria-live': 'polite' },
      busy ? 'Trabajando…' : (message && message.text) || '',
    ),
    el(
      'ol',
      { class: 'ip-flow' },
      el('li', {}, el('strong', {}, 'Edita'), ' la columna del entorno. Cada rama usa su columna; las ramas feature usan Desarrollo.'),
      el('li', {}, el('strong', {}, 'Aplica'), ' para verlo en desarrollo, stage y pre-producción (aem.page).'),
      el('li', {}, el('strong', {}, 'Publica'), ' para que la columna Producción llegue al sitio público. Requiere rol de publicación.'),
    ),
    ...INTEGRATIONS.map(renderIntegration),
    el(
      'footer',
      { class: 'ip-foot' },
      el('p', {}, 'Las hojas son públicas: pon solo claves públicas (p. ej. la API key de Gigya), nunca secretos.'),
      el('p', {}, 'Rutas: separa varias con comas. "/account/**" incluye /account y todo lo que cuelga; "*" no cruza "/".'),
      el('p', {}, el('a', { href: `https://da.live/#/${ctx.org}/${ctx.repo}${CONFIG_FOLDER}`, target: '_blank', rel: 'noopener' }, `Abrir la carpeta ${CONFIG_FOLDER} en da.live`)),
    ),
  );
}

async function loadIntegration(integration) {
  const [draft, preview, live, permissions] = await Promise.allSettled([
    readDraft(integration.id), readTier(integration.id, 'page'), readTier(integration.id, 'live'), readPermissions(integration.id),
  ]);
  if (draft.status === 'rejected') {
    // Sin borrador no se escribe nada: se sobrescribiría la hoja con valores por defecto
    sheets[integration.id] = { error: `No se pudo leer la hoja (${draft.reason.message}). Recarga para reintentar.` };
    return;
  }
  sheets[integration.id] = {
    saved: draft.value.config,
    draft: structuredClone(draft.value.config),
    canEdit: draft.value.canEdit,
    preview: preview.value,
    live: live.value,
    ...permissions.value,
  };
}

async function reload(clearMessage = true) {
  if (clearMessage) message = null;
  busy = true;
  render();
  await Promise.all(INTEGRATIONS.map(loadIntegration));
  busy = false;
  render();
}

(async function init() {
  const sdk = await DA_SDK;
  ({ token } = sdk);
  ctx = { ...sdk.context, ref: sdk.context.ref || 'main' };
  await reload();
}());
