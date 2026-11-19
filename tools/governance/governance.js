/*
 * Gobierno y accesos (app de da.live).
 * Abrir en: https://da.live/app/{org}/{site}/tools/governance
 *
 * Modelo (DA, no Git):  /governance/users.json      una fila por usuario
 *                       /governance/audit.json      registro de cambios
 *                       /governance/requests/*.json una hoja por solicitud
 * Plataforma:           hoja `permissions` de la config de la org (DA, por ruta)
 *                       roles del sitio en la Admin API (EDS, todo el sitio)
 *
 * La app no "concede" nada por sí sola: escribe la config real y la plataforma la aplica.
 * Lo que la plataforma no puede limitar por ruta (preview / publicar) se marca como
 * "solo modelo".
 */
/* render() y los manejadores se llaman entre sí */
/* eslint-disable no-use-before-define */
// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';
import {
  ACTIONS, AUDIT_SHEET, EDS_ROLES, EMAIL_RE, GOV_FOLDER, REQUESTS_FOLDER, ROLES, USERS_SHEET,
  accessLevel, buildDaRows, buildEdsRoles, cleanUser, describeChange, diffRoles, diffRows,
  diffUsers, edsAllows, edsRoleOf, evaluateDaRows, evaluateModel, foreignSiteRows, isActive,
  isAdmin, isManagedRow, mergeDaRows, normalizePath, sheetRows, splitList, toRow, toSheet,
  uniquePaths,
} from './model.js';

const DA_ADMIN = 'https://admin.da.live';
const HLX_ADMIN = 'https://admin.hlx.page';
const DEFAULT_PATHS = ['/', '/en', '/es', '/fr', '/jp', '/formacion', '/config', '/media', '/forms', '/docs'];

const S = {
  ctx: null,
  token: null,
  me: { email: '', name: '', verified: false },
  viewAs: '',
  tab: 'overview',
  loading: true,
  busy: false,
  toast: null,
  modelExists: false,
  saved: [],
  draft: [],
  da: { rows: null, raw: null, error: null },
  eds: { role: null, access: null, error: null },
  requests: [],
  audit: [],
  paths: DEFAULT_PATHS,
  modal: null,
  applyRun: null,
  pendingRequest: null,
  auditFilter: '',
  sim: { email: '', action: 'edit', path: '/fr' },
};

/* ---------- Utilidades ---------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([name, value]) => {
    if (name === 'class') node.className = value;
    else if (name === 'style') node.setAttribute('style', value);
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (value === true) node.setAttribute(name, '');
    else if (![false, null, undefined].includes(value)) node.setAttribute(name, value);
  });
  children.flat(Infinity).forEach((child) => {
    if (![false, null, undefined, ''].includes(child)) node.append(child);
  });
  return node;
}

const icon = (name) => {
  const paths = {
    shield: 'M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z',
    users: 'M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM22 19v-1a4 4 0 00-3-3.9M16 3.1a3.5 3.5 0 010 6.8',
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    flask: 'M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 006 21h12a1.7 1.7 0 001.5-2.5L14 9V3',
    inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v6a2 2 0 01-2 2H4a2 2 0 01-2-2v-6z',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    rocket: 'M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2 2 0 00-2.9-.1zM12 15l-3-3a22 22 0 012-4A13 13 0 0122 2c0 2.7-.8 7.5-6 11a22 22 0 01-4 2z',
    home: 'M3 11l9-8 9 8M5 9.5V21h14V9.5',
    lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
    plus: 'M12 5v14M5 12h14',
    check: 'M5 12l5 5L20 7',
    x: 'M6 6l12 12M18 6L6 18',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
    refresh: 'M21 12a9 9 0 01-15.5 6.2L3 16M3 12a9 9 0 0115.5-6.2L21 8M21 3v5h-5M3 21v-5h5',
    download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
    me: 'M20 21a8 8 0 00-16 0M12 13a5 5 0 100-10 5 5 0 000 10z',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'gv-icon');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name] || '');
  svg.append(p);
  return svg;
};

const auth = () => ({ Authorization: `Bearer ${S.token}` });
const site = () => S.ctx.repo;
const daSource = (path) => `${DA_ADMIN}/source/${S.ctx.org}/${site()}${path}`;
const now = () => new Date().toISOString();
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const byEmail = (list, email) => list.find((u) => u.email === String(email || '').toLowerCase());
const nameOf = (email) => byEmail(S.draft, email)?.name || email;
const initials = (u) => (u.name || u.email).split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase())
  .join('');

function toast(type, text) {
  S.toast = { type, text, id: Date.now() };
  render();
  const { id } = S.toast;
  setTimeout(() => { if (S.toast?.id === id) { S.toast = null; render(); } }, type === 'error' ? 9000 : 4500);
}

/* ---------- Identidad ---------- */

/** El usuario real; si un admin usa "Ver como", el usuario simulado */
const actor = () => byEmail(S.saved, S.me.email);
const viewer = () => (S.viewAs ? byEmail(S.draft, S.viewAs) : actor());
const amAdmin = () => isAdmin(actor()) && !S.viewAs;
const canReview = () => !S.viewAs && ['admin', 'publisher'].includes(actor()?.role) && isActive(actor());

async function loadIdentity() {
  const attempts = [
    async () => {
      const resp = await fetch('https://ims-na1.adobelogin.com/ims/profile/v1', { headers: auth() });
      if (!resp.ok) throw new Error();
      const p = await resp.json();
      return { email: p.email, name: p.displayName || p.name || [p.first_name, p.last_name].filter(Boolean).join(' ') };
    },
    async () => {
      const resp = await fetch(`${HLX_ADMIN}/profile/${S.ctx.org}/${site()}/main`, { headers: auth() });
      if (!resp.ok) throw new Error();
      const { profile } = await resp.json();
      return { email: profile.email, name: profile.name };
    },
  ];
  // eslint-disable-next-line no-restricted-syntax
  for (const attempt of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const p = await attempt();
      if (p?.email) {
        S.me = { email: p.email.toLowerCase(), name: p.name || '', verified: true };
        return;
      }
    } catch { /* siguiente método */ }
  }
  try {
    const stored = sessionStorage.getItem('gv-me');
    if (stored) S.me = { email: stored, name: '', verified: false };
  } catch { /* sin almacenamiento */ }
}

/* ---------- API ---------- */

async function readSheet(path) {
  const resp = await fetch(daSource(path), { headers: auth(), cache: 'no-store' });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`da.live respondió ${resp.status} al leer ${path}`);
  return resp.json();
}

async function writeSheet(path, rows) {
  const form = new FormData();
  form.append('data', new Blob([JSON.stringify(toSheet(rows))], { type: 'application/json' }));
  const resp = await fetch(daSource(path), { method: 'POST', headers: auth(), body: form });
  if (resp.status === 401 || resp.status === 403) throw new Error(`da.live no te permite escribir ${path}.`);
  if (!resp.ok) throw new Error(`No se pudo guardar ${path} (${resp.status}).`);
}

async function readOrgConfig() {
  const resp = await fetch(`${DA_ADMIN}/config/${S.ctx.org}/`, { headers: auth(), cache: 'no-store' });
  if (resp.status === 404) return { raw: null, rows: null };
  if (resp.status === 401 || resp.status === 403) throw new Error('No tienes permiso para leer la config de la org.');
  if (!resp.ok) throw new Error(`Config de la org: ${resp.status}`);
  const raw = await resp.json();
  const sheet = raw[':type'] === 'multi-sheet' ? raw.permissions : null;
  return { raw, rows: sheet ? sheetRows(sheet) : null };
}

async function writeOrgConfig(raw, rows) {
  let multi;
  if (!raw) multi = { ':names': [], ':version': 3, ':type': 'multi-sheet' };
  else if (raw[':type'] === 'multi-sheet') multi = structuredClone(raw);
  else {
    multi = {
      ':names': ['data'], ':version': 3, ':type': 'multi-sheet', data: raw,
    };
  }
  multi.permissions = toSheet(rows);
  if (!multi[':names'].includes('permissions')) multi[':names'] = [...multi[':names'], 'permissions'];
  const form = new FormData();
  form.append('config', JSON.stringify(multi));
  const resp = await fetch(`${DA_ADMIN}/config/${S.ctx.org}/`, { method: 'POST', headers: auth(), body: form });
  if (resp.status === 401 || resp.status === 403) throw new Error('da.live no te deja escribir la config de la org (hace falta CONFIG write).');
  if (!resp.ok) throw new Error(`No se pudo guardar la hoja permissions (${resp.status}).`);
}

const siteConfigUrl = () => `${HLX_ADMIN}/config/${S.ctx.org}/sites/${site()}`;

async function readSiteAccess() {
  const resp = await fetch(`${siteConfigUrl()}.json`, { headers: auth(), cache: 'no-store' });
  if (resp.status === 401 || resp.status === 403) throw new Error('Tu rol no permite leer la config del sitio (solo admin).');
  if (!resp.ok) throw new Error(`Config del sitio: ${resp.status} ${resp.headers.get('x-error') || ''}`);
  const cfg = await resp.json();
  return { access: cfg.access || {}, role: cfg.access?.admin?.role || {} };
}

const accessPayload = (access, role) => ({ ...access, admin: { ...(access?.admin || {}), role } });

async function writeSiteAccess(access, role) {
  const resp = await fetch(`${siteConfigUrl()}/access.json`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify(accessPayload(access, role)),
  });
  if (resp.status === 401 || resp.status === 403) throw new Error('La Admin API no te deja cambiar los roles del sitio (hace falta rol admin).');
  if (!resp.ok) throw new Error(`Roles del sitio: ${resp.status} ${resp.headers.get('x-error') || ''}`);
}

async function listFolder(path) {
  const resp = await fetch(`${DA_ADMIN}/list/${S.ctx.org}/${site()}${path}`, { headers: auth(), cache: 'no-store' });
  if (!resp.ok) return [];
  return resp.json();
}

async function loadRequests() {
  const items = (await listFolder(REQUESTS_FOLDER)).filter((i) => i.ext === 'json');
  const sheets = await Promise.all(items.map(async (i) => {
    try {
      const json = await readSheet(`${REQUESTS_FOLDER}/${i.name}.json`);
      const row = sheetRows(json)[0];
      return row ? { ...row, file: `${REQUESTS_FOLDER}/${i.name}.json` } : null;
    } catch { return null; }
  }));
  return sheets.filter(Boolean).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

async function appendAudit(entries) {
  if (!entries.length) return;
  const current = sheetRows(await readSheet(AUDIT_SHEET));
  await writeSheet(AUDIT_SHEET, [...entries, ...current]);
}

const auditEntry = (action, target, detail, result = 'ok') => ({
  date: now(), actor: S.me.email || 'desconocido', action, target, detail, result,
});

/* ---------- Carga ---------- */

async function reload(quiet = false) {
  if (!quiet) S.loading = true;
  render();
  const [model, org, eds, reqs, audit, folders] = await Promise.allSettled([
    readSheet(USERS_SHEET), readOrgConfig(), readSiteAccess(), loadRequests(),
    readSheet(AUDIT_SHEET), listFolder(''),
  ]);
  if (model.status === 'fulfilled') {
    S.modelExists = !!model.value;
    S.saved = sheetRows(model.value).map(cleanUser).filter((u) => u.email);
    S.draft = structuredClone(S.saved);
    S.modelError = null;
  } else {
    S.modelError = model.reason.message;
  }
  S.da = org.status === 'fulfilled' ? { ...org.value, error: null } : { rows: null, raw: null, error: org.reason.message };
  S.eds = eds.status === 'fulfilled' ? { ...eds.value, error: null } : { role: null, access: null, error: eds.reason.message };
  S.requests = reqs.status === 'fulfilled' ? reqs.value : [];
  S.audit = audit.status === 'fulfilled' ? sheetRows(audit.value) : [];
  if (folders.status === 'fulfilled' && folders.value.length) {
    const found = folders.value.filter((i) => !i.ext).map((i) => `/${i.name}`);
    S.paths = uniquePaths(['/', ...found, ...DEFAULT_PATHS.filter((p) => found.includes(p))]).filter((p) => p !== GOV_FOLDER);
  }
  if (!S.sim.email) S.sim.email = S.draft.find((u) => !isAdmin(u))?.email || S.draft[0]?.email || '';
  S.loading = false;
  render();
}

/* ---------- Estado derivado ---------- */

function pending() {
  const users = diffUsers(S.saved, S.draft);
  const generated = buildDaRows(S.draft, site());
  const current = (S.da.rows || []).filter((r) => isManagedRow(r, site()));
  const da = diffRows(current, generated);
  const nextRoles = S.eds.role ? buildEdsRoles(S.draft, S.eds.role) : null;
  const eds = nextRoles ? diffRoles(S.eds.role, nextRoles) : [];
  const total = users.length + da.added.length + da.removed.length + eds.length;
  return {
    users, da, eds, generated, nextRoles, total,
  };
}

/* ---------- Acciones del modelo ---------- */

function upsertDraft(user) {
  const clean = cleanUser({ ...user, updated: now(), updatedBy: S.me.email });
  const i = S.draft.findIndex((u) => u.email === clean.email);
  if (i >= 0) S.draft[i] = clean;
  else S.draft.push(clean);
  S.draft.sort((a, b) => (b.protected - a.protected) || a.email.localeCompare(b.email));
}

async function initModel(form) {
  const email = String(form.get('email')).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) { toast('error', 'Escribe un email válido.'); return; }
  S.busy = true;
  render();
  try {
    const admin = cleanUser({
      email, name: form.get('name'), role: 'admin', write: ['/'], read: ['/'], protected: true, updated: now(), updatedBy: email,
    });
    await writeSheet(USERS_SHEET, [toRow(admin)]);
    if (!S.me.verified) {
      S.me.email = email;
      try { sessionStorage.setItem('gv-me', email); } catch { /* ignorar */ }
    }
    await appendAudit([auditEntry('inicializar', email, 'Modelo creado con este usuario como admin protegido.')]);
    toast('ok', 'Modelo creado. Añade usuarios y aplica los cambios en la plataforma.');
    S.tab = 'users';
  } catch (e) {
    toast('error', e.message);
  }
  S.busy = false;
  await reload(true);
}

async function runApply() {
  const p = pending();
  const steps = [
    { id: 'model', label: 'Guardar modelo', state: p.users.length ? 'todo' : 'skip' },
    { id: 'da', label: 'Permisos DA (hoja permissions)', state: p.da.added.length || p.da.removed.length ? 'todo' : 'skip' },
    { id: 'eds', label: 'Roles del sitio (Admin API)', state: p.eds.length ? 'todo' : 'skip' },
    { id: 'audit', label: 'Registro de auditoría', state: 'todo' },
  ];
  S.applyRun = { steps, fallback: null };
  S.busy = true;
  S.modal = null;
  render();
  const set = (id, state, note) => {
    const step = steps.find((s) => s.id === id);
    Object.assign(step, { state, note });
    render();
  };
  const audit = [];
  try {
    if (steps[0].state === 'todo') {
      set('model', 'run');
      const fresh = sheetRows(await readSheet(USERS_SHEET)).map(cleanUser);
      if (JSON.stringify(fresh.map(toRow)) !== JSON.stringify(S.saved.map(toRow))) {
        throw new Error('Alguien ha cambiado el modelo mientras editabas. Recarga y repite los cambios.');
      }
      await writeSheet(USERS_SHEET, S.draft.map(toRow));
      p.users.forEach((c) => audit.push(auditEntry(c.type === 'alta' ? 'alta' : 'cambio', c.email, describeChange(c, S.draft))));
      set('model', 'ok', `${p.users.length} cambio(s)`);
    }
    if (steps[1].state === 'todo') {
      set('da', 'run');
      const org = await readOrgConfig();
      const merged = mergeDaRows(org.rows, p.generated, site());
      await writeOrgConfig(org.raw, merged);
      audit.push(auditEntry('aplicar-da', 'permissions', `+${p.da.added.length} / −${p.da.removed.length} reglas`));
      set('da', 'ok', `+${p.da.added.length} / −${p.da.removed.length} reglas`);
    }
    if (steps[2].state === 'todo') {
      set('eds', 'run');
      try {
        const fresh = await readSiteAccess();
        const role = buildEdsRoles(S.draft, fresh.role);
        await writeSiteAccess(fresh.access, role);
        audit.push(auditEntry('aplicar-eds', 'roles', p.eds.map((c) => `${c.type === 'add' ? '+' : '−'}${c.role}:${c.email}`).join(', ')));
        set('eds', 'ok', `${p.eds.length} cambio(s) de rol`);
      } catch (e) {
        S.applyRun.fallback = accessPayload(S.eds.access, p.nextRoles);
        audit.push(auditEntry('aplicar-eds', 'roles', e.message, 'error'));
        set('eds', 'error', e.message);
      }
    }
    if (S.pendingRequest) {
      const req = S.requests.find((r) => r.id === S.pendingRequest);
      if (req) {
        await writeSheet(req.file, [{
          ...stripFile(req), status: 'aplicada', reviewer: S.me.email, reviewed: now(),
        }]);
        audit.push(auditEntry('solicitud-aplicada', req.email, `Solicitud ${req.id}`));
      }
      S.pendingRequest = null;
    }
    set('audit', 'run');
    await appendAudit(audit);
    set('audit', 'ok', `${audit.length} entrada(s)`);
    toast(steps.some((s) => s.state === 'error') ? 'error' : 'ok', steps.some((s) => s.state === 'error') ? 'Aplicado con avisos: revisa los pasos.' : 'Cambios aplicados en la plataforma.');
  } catch (e) {
    const running = steps.find((s) => s.state === 'run');
    if (running) set(running.id, 'error', e.message);
    try { await appendAudit([...audit, auditEntry('aplicar', 'plataforma', e.message, 'error')]); } catch { /* sin auditoría */ }
    toast('error', e.message);
  }
  S.busy = false;
  await reload(true);
}

const stripFile = ({ file, ...rest }) => rest;

async function submitRequest(form) {
  const me = actor();
  const role = form.get('role');
  const write = uniquePaths(form.getAll('write'));
  const reason = String(form.get('reason') || '').trim();
  if (!reason) { toast('error', 'Explica el motivo de la solicitud.'); return; }
  const id = `req-${Date.now().toString(36)}`;
  const row = {
    id,
    created: now(),
    email: S.me.email,
    name: me?.name || S.me.name,
    currentRole: me?.role || '',
    role,
    write: write.join(', '),
    read: '/',
    reason,
    status: 'pendiente',
    reviewer: '',
    reviewed: '',
    note: '',
  };
  S.busy = true;
  render();
  try {
    await writeSheet(`${REQUESTS_FOLDER}/${id}.json`, [row]);
    toast('ok', 'Solicitud enviada. Un admin la revisará.');
    S.modal = null;
  } catch (e) {
    toast('error', `${e.message} ¿Estás dado de alta en el modelo y aplicado en la plataforma?`);
  }
  S.busy = false;
  await reload(true);
}

async function reviewRequest(req, status, note = '') {
  S.busy = true;
  render();
  try {
    await writeSheet(req.file, [{
      ...stripFile(req), status, reviewer: S.me.email, reviewed: now(), note,
    }]);
    await appendAudit([auditEntry(`solicitud-${status}`, req.email, `${req.id}${note ? ` · ${note}` : ''}`)]);
    toast('ok', `Solicitud ${status}.`);
  } catch (e) {
    toast('error', e.message);
  }
  S.busy = false;
  await reload(true);
}

function approveAndStage(req) {
  const current = byEmail(S.draft, req.email);
  const write = splitList(req.write);
  upsertDraft({
    ...(current || {}),
    email: req.email,
    name: current?.name || req.name,
    role: current?.protected ? current.role : req.role,
    write: [...(current?.write || []), ...write],
    read: [...(current?.read || []), ...splitList(req.read || '/')],
    status: 'activo',
  });
  S.pendingRequest = req.id;
  S.tab = 'apply';
  toast('ok', 'Solicitud incorporada al modelo. Revisa el diff y aplica.');
}

/* ---------- Componentes ---------- */

const roleBadge = (role) => el('span', { class: `gv-role gv-role-${role}` }, ROLES[role]?.short || role);

const avatar = (u) => el('span', { class: `gv-avatar gv-role-bg-${u.role}`, 'aria-hidden': 'true' }, initials(u));

const pathChip = (p, level = 'write') => el('span', { class: `gv-path gv-path-${level}` }, p);

function verdict(value, labelYes = 'Permitido', labelNo = 'Denegado') {
  if (value === null || value === undefined) return el('span', { class: 'gv-verdict gv-verdict-na' }, 'Sin restricción');
  return el('span', { class: `gv-verdict gv-verdict-${value ? 'yes' : 'no'}` }, icon(value ? 'check' : 'x'), value ? labelYes : labelNo);
}

function emptyState(title, text, action) {
  return el('div', { class: 'gv-empty' }, el('div', { class: 'gv-orb gv-orb-sm', 'aria-hidden': 'true' }), el('h3', {}, title), el('p', {}, text), action);
}

function stat(label, value, hint, tone = '') {
  return el('div', { class: `gv-stat ${tone}` }, el('span', { class: 'gv-stat-label' }, label), el('strong', { class: 'gv-stat-value' }, String(value)), hint && el('span', { class: 'gv-stat-hint' }, hint));
}

/* ---------- Vistas ---------- */

function checkClass(c) {
  if (c.ok) return 'is-ok';
  return c.warn ? 'is-warn' : 'is-bad';
}

function writeCell(u) {
  if (u.role === 'admin') return pathChip('todo el sitio');
  if (!u.write.length) return el('span', { class: 'gv-muted' }, '—');
  return u.write.map((p) => pathChip(p));
}

function viewOverview() {
  const p = pending();
  const active = S.draft.filter(isActive);
  const governed = new Set(active.flatMap((u) => [...u.write, ...u.read]));
  const pendingReqs = S.requests.filter((r) => ['pendiente', 'preaprobada'].includes(r.status));
  const protectedAdmin = S.draft.find((u) => u.protected && isActive(u));
  const foreign = foreignSiteRows(S.da.rows, site());
  const hasRoles = !!(S.eds.role && Object.keys(S.eds.role).length);
  let edsText = hasRoles ? 'Roles del sitio configurados' : 'Sin roles en el sitio: cualquiera con acceso puede publicar';
  if (S.eds.error) edsText = `Roles EDS: ${S.eds.error}`;
  const checks = [
    { ok: !!protectedAdmin, text: protectedAdmin ? `Admin protegido: ${protectedAdmin.email}` : 'No hay admin protegido' },
    { ok: !!S.da.rows, warn: !S.da.rows, text: S.da.rows ? 'Hoja permissions activa en la org' : 'La org aún no tiene hoja permissions: DA no restringe por rutas' },
    { ok: hasRoles, warn: true, text: edsText },
    { ok: p.total === 0, warn: true, text: p.total ? `${p.total} cambio(s) entre el modelo y la plataforma` : 'Plataforma sincronizada con el modelo' },
    { ok: !foreign.length, warn: true, text: foreign.length ? `${foreign.length} regla(s) manuales fuera del modelo afectan al sitio` : 'Sin reglas manuales fuera del modelo' },
  ];
  return el(
    'div',
    { class: 'gv-stack' },
    el(
      'section',
      { class: 'gv-hero' },
      el('div', { class: 'gv-orb', 'aria-hidden': 'true' }),
      el(
        'div',
        { class: 'gv-hero-text' },
        el('p', { class: 'gv-eyebrow' }, 'Modelo de gobierno'),
        el('h2', {}, 'Quién puede hacer qué, y dónde.'),
        el('p', {}, 'Define roles y rutas una vez. La app lo traduce a permisos de Experience Workspace por ruta y a roles del sitio en EDS, y deja rastro de cada cambio.'),
      ),
    ),
    el(
      'div',
      { class: 'gv-stats' },
      stat('Usuarios activos', active.length, `${S.draft.length - active.length} de baja`),
      stat('Rutas gobernadas', governed.size, [...governed].slice(0, 4).join(' · ')),
      stat('Solicitudes abiertas', pendingReqs.length, pendingReqs.length ? 'Revisar en Solicitudes' : 'Nada pendiente', pendingReqs.length ? 'gv-stat-accent' : ''),
      stat('Cambios sin aplicar', p.total, p.total ? 'Ver en Aplicar' : 'Todo al día', p.total ? 'gv-stat-warn' : 'gv-stat-ok'),
    ),
    el(
      'div',
      { class: 'gv-grid-2' },
      el(
        'section',
        { class: 'gv-card' },
        el('h3', {}, 'Salud del gobierno'),
        el('ul', { class: 'gv-checks' }, checks.map((c) => el('li', { class: checkClass(c) }, icon(c.ok ? 'check' : 'alert'), c.text))),
      ),
      el(
        'section',
        { class: 'gv-card' },
        el('h3', {}, 'Roles'),
        el('ul', { class: 'gv-role-list' }, Object.entries(ROLES).map(([id, r]) => {
          const count = active.filter((u) => u.role === id).length;
          return el('li', {}, roleBadge(id), el('span', { class: 'gv-role-desc' }, r.description), el('strong', {}, count));
        })),
      ),
    ),
    el(
      'section',
      { class: 'gv-card' },
      el('h3', {}, 'Qué aplica cada capa'),
      el(
        'div',
        { class: 'gv-layers' },
        el('div', { class: 'gv-layer' }, el('span', { class: 'gv-layer-tag gv-layer-da' }, 'DA · por ruta'), el('p', {}, 'Leer y editar (crear, mover, borrar) documentos. Hoja ', el('code', {}, 'permissions'), ' de la org; solo se tocan las filas ', el('code', {}, `gov:${site()}`), '.')),
        el('div', { class: 'gv-layer' }, el('span', { class: 'gv-layer-tag gv-layer-eds' }, 'EDS · todo el sitio'), el('p', {}, 'Preview (', el('code', {}, 'author'), ') y publicar (', el('code', {}, 'publish'), '). La plataforma no lo limita por ruta.')),
        el('div', { class: 'gv-layer' }, el('span', { class: 'gv-layer-tag gv-layer-app' }, 'Solo modelo'), el('p', {}, 'Publicar o hacer preview solo en tus rutas y aprobar solicitudes. Lo controla la app y lo registra la auditoría.')),
      ),
    ),
    S.audit.length ? el(
      'section',
      { class: 'gv-card' },
      el('div', { class: 'gv-card-head' }, el('h3', {}, 'Actividad reciente'), el('button', { class: 'gv-link', onclick: () => go('audit') }, 'Ver todo')),
      auditTable(S.audit.slice(0, 5)),
    ) : null,
  );
}

function userRow(u) {
  const locked = u.protected;
  const self = u.email === S.me.email;
  const changed = diffUsers(S.saved, [u]).length > 0;
  return el(
    'tr',
    { class: `${isActive(u) ? '' : 'is-off'} ${changed ? 'is-changed' : ''}` },
    el('td', {}, el('div', { class: 'gv-user' }, avatar(u), el('div', {}, el('strong', {}, u.name || u.email.split('@')[0], locked ? el('span', { class: 'gv-lock', title: 'Admin protegido: no se puede degradar ni dar de baja' }, icon('lock')) : null), el('span', { class: 'gv-sub' }, u.email)))),
    el('td', {}, roleBadge(u.role), el('small', { class: 'gv-eds' }, `EDS: ${edsRoleOf(u) || '—'}`)),
    el('td', {}, writeCell(u)),
    el('td', {}, u.role === 'admin' ? pathChip('todo', 'read') : u.read.map((p) => pathChip(p, 'read'))),
    el('td', {}, el('span', { class: `gv-status gv-status-${u.status}` }, u.status), changed ? el('span', { class: 'gv-dot', title: 'Cambio sin aplicar' }) : null),
    el(
      'td',
      { class: 'gv-row-actions' },
      el('button', {
        class: 'gv-btn gv-btn-ghost', disabled: S.busy, onclick: () => openUserModal(u), 'aria-label': `Editar ${u.email}`,
      }, 'Editar'),
      !locked && !self ? el('button', {
        class: 'gv-btn gv-btn-ghost', disabled: S.busy, onclick: () => { upsertDraft({ ...u, status: isActive(u) ? 'baja' : 'activo' }); render(); },
      }, isActive(u) ? 'Dar de baja' : 'Reactivar') : null,
      el('button', {
        class: 'gv-btn gv-btn-ghost', title: 'Ver la app como este usuario', onclick: () => { S.viewAs = u.email; S.tab = 'me'; render(); },
      }, icon('eye')),
    ),
  );
}

function viewUsers() {
  if (!S.draft.length) return emptyState('Sin usuarios', 'Añade el primer usuario.', null);
  return el(
    'section',
    { class: 'gv-card gv-card-flush' },
    el(
      'div',
      { class: 'gv-card-head gv-pad' },
      el('div', {}, el('h3', {}, 'Usuarios y rutas'), el('p', { class: 'gv-muted' }, 'Los cambios se quedan en borrador hasta que los apliques.')),
      el('button', { class: 'gv-btn gv-btn-primary', disabled: S.busy, onclick: () => openUserModal(null) }, icon('plus'), 'Añadir usuario'),
    ),
    el(
      'div',
      { class: 'gv-table-wrap' },
      el(
        'table',
        { class: 'gv-table' },
        el('thead', {}, el('tr', {}, ['Usuario', 'Rol', 'Escritura', 'Lectura', 'Estado', ''].map((h) => el('th', { scope: 'col' }, h)))),
        el('tbody', {}, S.draft.map(userRow)),
      ),
    ),
  );
}

function matrixCell(u, path) {
  const marks = ['read', 'edit', 'preview', 'publish'].map((action) => {
    const model = evaluateModel(u, action, path).allowed;
    let platform = null;
    if (action === 'read' || action === 'edit') {
      const r = evaluateDaRows(S.da.rows, u.email, site(), path);
      platform = r === null ? true : r.level >= (action === 'edit' ? 2 : 1);
    } else {
      const e = edsAllows(S.eds.role, u.email, action);
      platform = e === null ? true : e;
    }
    const gap = platform && !model;
    const missing = model && !platform;
    const { label } = ACTIONS.find((a) => a.id === action);
    let state = model ? 'yes' : 'no';
    if (gap) state = 'gap';
    if (missing) state = 'missing';
    const titles = {
      yes: `${label}: permitido`,
      no: `${label}: denegado`,
      gap: `${label}: el modelo lo deniega, pero la plataforma lo permite (solo modelo o sin aplicar)`,
      missing: `${label}: el modelo lo permite, pero falta aplicarlo en la plataforma`,
    };
    return el('span', { class: `gv-mark gv-mark-${state}`, title: titles[state] }, label[0]);
  });
  return el('td', {}, el('div', { class: 'gv-marks' }, marks));
}

function viewMatrix() {
  const users = S.draft.filter(isActive);
  const { paths } = S;
  return el(
    'div',
    { class: 'gv-stack' },
    el(
      'section',
      { class: 'gv-card gv-card-flush' },
      el('div', { class: 'gv-card-head gv-pad' }, el('div', {}, el('h3', {}, 'Matriz de accesos'), el('p', { class: 'gv-muted' }, 'Usuarios × rutas × acciones: L leer · E editar · P preview · P publicar.'))),
      el(
        'div',
        { class: 'gv-table-wrap' },
        el(
          'table',
          { class: 'gv-table gv-matrix' },
          el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, 'Usuario'), paths.map((p) => el('th', { scope: 'col' }, p)), el('th', { scope: 'col' }, 'Global'))),
          el('tbody', {}, users.map((u) => el(
            'tr',
            {},
            el('th', { scope: 'row' }, el('div', { class: 'gv-user gv-user-sm' }, avatar(u), el('div', {}, el('strong', {}, u.name || u.email.split('@')[0]), roleBadge(u.role)))),
            paths.map((p) => matrixCell(u, p)),
            el('td', {}, el('div', { class: 'gv-globals' }, ['config', 'approve', 'govern'].map((a) => {
              const ok = evaluateModel(u, a, '/').allowed;
              return el('span', { class: `gv-global ${ok ? 'is-yes' : ''}` }, ACTIONS.find((x) => x.id === a).label);
            }))),
          ))),
        ),
      ),
    ),
    el(
      'div',
      { class: 'gv-legend' },
      el('span', {}, el('span', { class: 'gv-mark gv-mark-yes' }, 'E'), 'Permitido'),
      el('span', {}, el('span', { class: 'gv-mark gv-mark-no' }, 'E'), 'Denegado'),
      el('span', {}, el('span', { class: 'gv-mark gv-mark-gap' }, 'P'), 'La plataforma lo permite pero el modelo no: lo controla la app'),
      el('span', {}, el('span', { class: 'gv-mark gv-mark-missing' }, 'E'), 'Falta aplicar en la plataforma'),
    ),
  );
}

function viewSimulator() {
  const users = S.draft.filter((u) => u.email);
  const u = byEmail(S.draft, S.sim.email) || users[0];
  const path = normalizePath(S.sim.path);
  const { action } = S.sim;
  const model = u ? evaluateModel(u, action, path) : null;
  let platform = null;
  let platformText = '';
  let enforced = '';
  if (u && ['read', 'edit'].includes(action)) {
    const r = evaluateDaRows(S.da.rows, u.email, site(), path);
    platform = r === null ? null : r.level >= (action === 'edit' ? 2 : 1);
    platformText = r?.rule ? `Regla real más específica: ${r.rule}` : 'Ninguna regla real cubre esta ruta para este usuario.';
    if (r === null) platformText = 'La org no tiene hoja permissions: DA no restringe.';
    enforced = 'Lo bloquea Experience Workspace (DA), por ruta.';
  } else if (u && ['preview', 'publish'].includes(action)) {
    platform = edsAllows(S.eds.role, u.email, action);
    platformText = platform === null ? 'El sitio no tiene roles: no hay restricción.' : `Rol real en el sitio: ${EDS_ROLES.filter((r) => (S.eds.role?.[r] || []).includes(u.email)).join(', ') || 'ninguno'}.`;
    enforced = 'EDS lo aplica para todo el sitio; el límite por ruta lo pone la app.';
  } else if (u && ['config', 'govern'].includes(action)) {
    const r = evaluateDaRows(S.da.rows, u.email, site(), 'CONFIG');
    platform = r === null ? null : r.level >= 2;
    platformText = r === null ? 'Sin hoja permissions.' : `CONFIG: ${['sin acceso', 'lectura', 'escritura'][r.level]}.`;
    enforced = 'Lo bloquea DA (CONFIG) y la Admin API (rol admin).';
  } else {
    platformText = 'Acción de la app: no existe en la plataforma.';
    enforced = 'Lo controla la app.';
  }
  const level = u ? accessLevel(u, path) : null;
  return el(
    'div',
    { class: 'gv-grid-sim' },
    el(
      'section',
      { class: 'gv-card' },
      el('h3', {}, '¿Puede…'),
      el(
        'form',
        { class: 'gv-form', onsubmit: (e) => e.preventDefault() },
        el('label', { for: 'sim-user' }, 'Usuario'),
        el('select', { id: 'sim-user', onchange: (e) => { S.sim.email = e.target.value; render(); } }, users.map((x) => el('option', { value: x.email, selected: x.email === u?.email }, `${x.name || x.email} · ${ROLES[x.role].short}`))),
        el('label', { for: 'sim-action' }, 'Acción'),
        el('div', { class: 'gv-seg', id: 'sim-action', role: 'radiogroup' }, ACTIONS.map((a) => el('button', {
          type: 'button', role: 'radio', 'aria-checked': String(a.id === action), class: a.id === action ? 'is-on' : '', onclick: () => { S.sim.action = a.id; render(); },
        }, a.label))),
        el('label', { for: 'sim-path' }, 'Ruta'),
        el('input', {
          id: 'sim-path', value: S.sim.path, list: 'gv-paths', placeholder: '/es/coffee', onchange: (e) => { S.sim.path = e.target.value; render(); },
        }),
        el('datalist', { id: 'gv-paths' }, S.paths.map((p) => el('option', { value: p }))),
      ),
    ),
    u ? el(
      'section',
      { class: `gv-card gv-sim-result ${model.allowed ? 'is-yes' : 'is-no'}` },
      el('p', { class: 'gv-eyebrow' }, `${u.name || u.email} · ${ACTIONS.find((a) => a.id === action).label} · ${path}`),
      el('div', { class: 'gv-sim-big' }, icon(model.allowed ? 'check' : 'x'), el('span', {}, model.allowed ? 'Sí, puede' : 'No puede')),
      el('p', {}, model.reason),
      el(
        'dl',
        { class: 'gv-dl' },
        el('dt', {}, 'Modelo'),
        el('dd', {}, verdict(model.allowed), level?.rule ? el('small', {}, ` regla ${level.rule}`) : null),
        el('dt', {}, 'Plataforma hoy'),
        el('dd', {}, verdict(platform), el('small', {}, ` ${platformText}`)),
        el('dt', {}, 'Quién lo aplica'),
        el('dd', {}, enforced),
      ),
      platform === true && !model.allowed ? el('p', { class: 'gv-callout gv-callout-warn' }, icon('alert'), ['preview', 'publish'].includes(action) ? 'La plataforma lo permitiría: este límite es solo del modelo (lo controla la app y lo registra la auditoría).' : 'La plataforma aún lo permite: aplica los cambios pendientes.') : null,
      platform === false && model.allowed ? el('p', { class: 'gv-callout gv-callout-warn' }, icon('alert'), 'El modelo lo permite pero la plataforma no todavía: aplica los cambios pendientes.') : null,
    ) : emptyState('Sin usuarios', 'Añade usuarios para simular.', null),
  );
}

function requestCard(r) {
  const mine = r.email === S.me.email;
  const open = ['pendiente', 'preaprobada'].includes(r.status);
  return el(
    'article',
    { class: `gv-req gv-req-${r.status}` },
    el(
      'header',
      {},
      el('div', { class: 'gv-user' }, avatar({ name: r.name, email: r.email, role: r.role }), el('div', {}, el('strong', {}, r.name || r.email), el('span', { class: 'gv-sub' }, r.email))),
      el('span', { class: `gv-pill gv-pill-${r.status}` }, r.status),
    ),
    el('p', { class: 'gv-req-what' }, r.currentRole && r.currentRole !== r.role ? [roleBadge(r.currentRole), ' → '] : null, roleBadge(r.role), ' ', splitList(r.write).map((p) => pathChip(p))),
    el('blockquote', {}, r.reason),
    el('p', { class: 'gv-muted' }, `Enviada ${fmtDate(r.created)}`, r.reviewer ? ` · revisada por ${nameOf(r.reviewer)} ${fmtDate(r.reviewed)}` : '', r.note ? ` · “${r.note}”` : ''),
    open ? el(
      'div',
      { class: 'gv-req-actions' },
      amAdmin() ? el('button', { class: 'gv-btn gv-btn-primary', disabled: S.busy, onclick: () => approveAndStage(r) }, icon('check'), 'Aprobar y aplicar') : null,
      canReview() && !amAdmin() && r.status === 'pendiente' && !mine ? el('button', { class: 'gv-btn gv-btn-primary', disabled: S.busy, onclick: () => reviewRequest(r, 'preaprobada') }, icon('check'), 'Preaprobar') : null,
      canReview() && !mine ? el('button', {
        class: 'gv-btn gv-btn-ghost',
        disabled: S.busy,
        onclick: () => {
          // eslint-disable-next-line no-alert
          const note = window.prompt('Motivo del rechazo (queda en la auditoría):', '');
          if (note !== null) reviewRequest(r, 'rechazada', note);
        },
      }, 'Rechazar') : null,
      mine ? el('button', { class: 'gv-btn gv-btn-ghost', disabled: S.busy, onclick: () => reviewRequest(r, 'cancelada') }, 'Cancelar') : null,
    ) : null,
  );
}

function viewRequests() {
  const who = viewer()?.email || S.me.email;
  const list = canReview() ? S.requests : S.requests.filter((r) => r.email === who);
  const open = list.filter((r) => ['pendiente', 'preaprobada'].includes(r.status));
  const closed = list.filter((r) => !open.includes(r));
  return el(
    'div',
    { class: 'gv-stack' },
    el(
      'section',
      { class: 'gv-card' },
      el(
        'div',
        { class: 'gv-card-head' },
        el('div', {}, el('h3', {}, canReview() ? 'Solicitudes de acceso' : 'Mis solicitudes'), el('p', { class: 'gv-muted' }, 'Flujo: solicitud → preaprobación (publicador) → un admin aprueba y aplica. Todo queda auditado.')),
        !S.viewAs && actor() ? el('button', { class: 'gv-btn gv-btn-primary', onclick: () => { S.modal = { type: 'request' }; render(); } }, icon('plus'), 'Solicitar acceso') : null,
      ),
    ),
    open.length ? el('div', { class: 'gv-reqs' }, open.map(requestCard)) : emptyState('Nada pendiente', 'No hay solicitudes abiertas.', null),
    closed.length ? el('details', { class: 'gv-card' }, el('summary', {}, `Histórico (${closed.length})`), el('div', { class: 'gv-reqs' }, closed.map(requestCard))) : null,
  );
}

function auditTable(rows) {
  return el(
    'div',
    { class: 'gv-table-wrap' },
    el(
      'table',
      { class: 'gv-table gv-audit' },
      el('thead', {}, el('tr', {}, ['Fecha', 'Quién', 'Acción', 'Sobre', 'Detalle', ''].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, rows.map((a) => el(
        'tr',
        {},
        el('td', { class: 'gv-nowrap' }, fmtDate(a.date)),
        el('td', {}, nameOf(a.actor)),
        el('td', {}, el('span', { class: 'gv-pill' }, a.action)),
        el('td', {}, a.target),
        el('td', { class: 'gv-detail' }, a.detail),
        el('td', {}, a.result === 'error' ? el('span', { class: 'gv-pill gv-pill-rechazada' }, 'error') : el('span', { class: 'gv-pill gv-pill-aplicada' }, 'ok')),
      ))),
    ),
  );
}

function exportAudit() {
  const cols = ['date', 'actor', 'action', 'target', 'detail', 'result'];
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const csv = [cols.join(','), ...S.audit.map((a) => cols.map((c) => esc(a[c])).join(','))].join('\n');
  const link = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `auditoria-${site()}.csv` });
  link.click();
}

function viewAudit() {
  const q = S.auditFilter.toLowerCase();
  const match = (a) => Object.values(a).some((v) => String(v).toLowerCase().includes(q));
  const rows = S.audit.filter((a) => !q || match(a));
  return el(
    'section',
    { class: 'gv-card gv-card-flush' },
    el(
      'div',
      { class: 'gv-card-head gv-pad' },
      el('div', {}, el('h3', {}, 'Auditoría'), el('p', { class: 'gv-muted' }, `${S.audit.length} entradas en ${AUDIT_SHEET}`)),
      el(
        'div',
        { class: 'gv-inline' },
        el('input', {
          type: 'search', placeholder: 'Filtrar…', value: S.auditFilter, 'aria-label': 'Filtrar auditoría', oninput: (e) => { S.auditFilter = e.target.value; renderSoon(); },
        }),
        el('button', { class: 'gv-btn gv-btn-ghost', disabled: !S.audit.length, onclick: exportAudit }, icon('download'), 'CSV'),
      ),
    ),
    rows.length ? auditTable(rows) : emptyState('Sin entradas', 'Aún no hay actividad registrada.', null),
  );
}

function rowsList(rows, sign) {
  return rows.map((r) => el('li', { class: `gv-diff-${sign === '+' ? 'add' : 'del'}` }, el('code', {}, `${sign} ${r.path}`), el('span', { class: 'gv-pill' }, r.actions), el('span', { class: 'gv-muted' }, r.groups)));
}

function viewApply() {
  const p = pending();
  const firstSheet = !S.da.rows && !S.da.error;
  const foreign = foreignSiteRows(S.da.rows, site());
  const run = S.applyRun;
  return el(
    'div',
    { class: 'gv-stack' },
    S.pendingRequest ? el('p', { class: 'gv-callout' }, icon('inbox'), `Aplicando la solicitud ${S.pendingRequest}. Al terminar se marcará como aplicada.`) : null,
    run ? el(
      'section',
      { class: 'gv-card' },
      el('h3', {}, 'Última aplicación'),
      el('ol', { class: 'gv-steps' }, run.steps.map((s) => el('li', { class: `is-${s.state}` }, el('span', { class: 'gv-step-dot' }), el('strong', {}, s.label), el('span', { class: 'gv-muted' }, s.note || {
        skip: 'sin cambios', todo: 'pendiente', run: 'en curso…', ok: 'hecho',
      }[s.state] || '')))),
      run.fallback ? el(
        'div',
        { class: 'gv-callout gv-callout-warn' },
        icon('alert'),
        el(
          'div',
          {},
          el('p', {}, 'No se pudieron escribir los roles desde el navegador. Un admin puede aplicarlos con la Admin API:'),
          el('pre', { class: 'gv-code' }, `curl -X POST ${siteConfigUrl()}/access.json \\\n  -H "authorization: Bearer $AEM_TOKEN" -H "content-type: application/json" \\\n  -d '${JSON.stringify(run.fallback)}'`),
          el('button', { class: 'gv-btn gv-btn-ghost', onclick: () => navigator.clipboard.writeText(JSON.stringify(run.fallback, null, 2)).then(() => toast('ok', 'JSON copiado.')) }, 'Copiar JSON'),
        ),
      ) : null,
    ) : null,
    el(
      'section',
      { class: 'gv-card' },
      el(
        'div',
        { class: 'gv-card-head' },
        el('div', {}, el('h3', {}, p.total ? `${p.total} cambio(s) por aplicar` : 'Todo sincronizado'), el('p', { class: 'gv-muted' }, 'Compara el modelo con lo que hay ahora en la plataforma.')),
        el('div', { class: 'gv-inline' }, p.users.length ? el('button', { class: 'gv-btn gv-btn-ghost', disabled: S.busy, onclick: () => { S.draft = structuredClone(S.saved); S.pendingRequest = null; render(); } }, 'Descartar borrador') : null, el('button', {
          class: 'gv-btn gv-btn-primary', disabled: S.busy || !p.total || !!S.da.error, onclick: () => { S.modal = { type: 'confirm' }; render(); },
        }, icon('rocket'), 'Aplicar en la plataforma')),
      ),
      S.da.error ? el('p', { class: 'gv-callout gv-callout-bad' }, icon('alert'), `No se pudo leer la config de la org: ${S.da.error}. No se aplicará nada sin leerla antes.`) : null,
      firstSheet ? el('p', { class: 'gv-callout gv-callout-warn' }, icon('alert'), 'La org aún no tiene hoja permissions. Al crearla, DA deniega el acceso a cualquiera que no esté en una regla, en todos los sitios de la org. Tu admin protegido conserva acceso total (/+** y CONFIG).') : null,
      foreign.length ? el('details', { class: 'gv-callout gv-callout-warn' }, el('summary', {}, `${foreign.length} regla(s) manuales afectan al sitio y no las gestiona el modelo (se conservan)`), el('ul', { class: 'gv-diff' }, rowsList(foreign, '·'))) : null,
      el('div', { class: 'gv-grid-3' }, [
        ['Modelo', p.users.map((c) => el('li', {}, describeChange(c, S.draft)))],
        ['Permisos DA', [...rowsList(p.da.added, '+'), ...rowsList(p.da.removed, '−')]],
        ['Roles EDS', S.eds.error ? [el('li', { class: 'gv-muted' }, S.eds.error)] : p.eds.map((c) => el('li', { class: `gv-diff-${c.type === 'add' ? 'add' : 'del'}` }, el('code', {}, `${c.type === 'add' ? '+' : '−'} ${c.role}`), el('span', { class: 'gv-muted' }, c.email)))],
      ].map(([title, items]) => el('div', { class: 'gv-diff-col' }, el('h4', {}, title, el('span', { class: 'gv-count' }, items.length)), items.length ? el('ul', { class: 'gv-diff' }, items) : el('p', { class: 'gv-muted' }, 'Sin cambios')))),
    ),
  );
}

function viewMe() {
  const u = viewer();
  if (!u && !S.me.verified) {
    return emptyState('¿Quién eres?', 'No se pudo leer tu perfil de Adobe. Elige tu cuenta: es solo para mostrar la vista; la plataforma valida tus permisos reales al guardar.', el('select', {
      'aria-label': 'Tu cuenta',
      onchange: (e) => {
        S.me = { email: e.target.value, name: '', verified: false };
        try { sessionStorage.setItem('gv-me', e.target.value); } catch { /* ignorar */ }
        render();
      },
    }, el('option', { value: '' }, 'Elige…'), S.saved.filter(isActive).map((x) => el('option', { value: x.email }, x.name || x.email))));
  }
  if (!u) {
    return emptyState('No estás en el modelo', `Pide a un admin que te dé de alta (${S.me.email || 'cuenta sin identificar'}).`, null);
  }
  const { paths } = S;
  return el(
    'div',
    { class: 'gv-stack' },
    el(
      'section',
      { class: 'gv-hero gv-hero-me' },
      el('div', { class: 'gv-orb', 'aria-hidden': 'true' }),
      el('div', { class: 'gv-hero-text' }, el('p', { class: 'gv-eyebrow' }, S.viewAs ? 'Vista simulada' : 'Mis accesos'), el('h2', {}, u.name || u.email), el('p', {}, roleBadge(u.role), ' ', ROLES[u.role].description)),
    ),
    el(
      'section',
      { class: 'gv-card' },
      el('h3', {}, 'Lo que puedes hacer en cada ruta'),
      el('div', { class: 'gv-me-grid' }, paths.map((p) => {
        const acts = ['read', 'edit', 'preview', 'publish'].filter((a) => evaluateModel(u, a, p).allowed);
        return el('div', { class: `gv-me-path ${acts.length ? '' : 'is-none'}` }, el('code', {}, p), el('div', {}, acts.length ? acts.map((a) => el('span', { class: 'gv-pill gv-pill-aplicada' }, ACTIONS.find((x) => x.id === a).label)) : el('span', { class: 'gv-muted' }, 'Sin acceso')));
      })),
    ),
    !S.viewAs ? el('button', { class: 'gv-btn gv-btn-primary gv-self-start', onclick: () => { S.modal = { type: 'request' }; render(); } }, icon('plus'), 'Solicitar más acceso') : null,
  );
}

/* ---------- Modales ---------- */

function pathPicker(name, selected, level) {
  const options = uniquePaths([...S.paths, ...selected]);
  const box = el('div', { class: 'gv-picker', role: 'group' }, options.map((p) => el('label', { class: `gv-pick gv-path-${level}` }, el('input', {
    type: 'checkbox', name, value: p, checked: selected.includes(p),
  }), p)));
  const extra = el('input', {
    type: 'text', placeholder: 'Otra ruta: /es/campanas', 'aria-label': `Añadir ruta (${name})`, class: 'gv-picker-add',
  });
  extra.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const p = normalizePath(extra.value);
    if (!extra.value.trim()) return;
    box.append(el('label', { class: `gv-pick gv-path-${level}` }, el('input', {
      type: 'checkbox', name, value: p, checked: true,
    }), p));
    extra.value = '';
  });
  return el('div', {}, box, extra);
}

function userModal() {
  const editing = S.modal.user;
  const u = editing || cleanUser({ role: 'editor', ...ROLES.editor.defaults });
  const locked = !!editing?.protected;
  const self = editing && editing.email === S.me.email;
  const form = el(
    'form',
    {
      class: 'gv-form',
      onsubmit: (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const email = String(f.get('email') || u.email).trim().toLowerCase();
        if (!EMAIL_RE.test(email)) { toast('error', 'Email no válido.'); return; }
        if (!editing && byEmail(S.draft, email)) { toast('error', 'Ese usuario ya existe: edítalo.'); return; }
        const role = locked || self ? u.role : f.get('role');
        upsertDraft({
          ...u,
          email,
          name: f.get('name'),
          role,
          write: role === 'admin' ? ['/'] : f.getAll('write'),
          read: role === 'admin' || !f.getAll('read').length ? ['/'] : f.getAll('read'),
          notes: f.get('notes'),
        });
        S.modal = null;
        render();
      },
    },
    el('div', { class: 'gv-grid-2' }, el('div', {}, el('label', { for: 'u-email' }, 'Email (Adobe ID)'), el('input', {
      id: 'u-email', name: 'email', type: 'email', required: true, value: u.email, disabled: !!editing, placeholder: 'nombre@empresa.com',
    })), el('div', {}, el('label', { for: 'u-name' }, 'Nombre'), el('input', { id: 'u-name', name: 'name', value: u.name }))),
    el('fieldset', { class: 'gv-roles-pick', disabled: locked || self }, el('legend', {}, 'Rol', locked ? ' (admin protegido)' : '', self && !locked ? ' (no puedes cambiar tu propio rol)' : ''), Object.entries(ROLES).map(([id, r]) => el('label', { class: `gv-role-card gv-role-card-${id}` }, el('input', {
      type: 'radio', name: 'role', value: id, checked: u.role === id,
    }), el('strong', {}, r.label), el('span', {}, r.description), el('small', {}, `EDS: ${r.eds || 'ninguno (author si tiene escritura)'}`)))),
    el('label', {}, 'Rutas con escritura (edita; preview/publicar según rol)'),
    pathPicker('write', u.write, 'write'),
    el('label', {}, 'Rutas con lectura'),
    pathPicker('read', u.read.length ? u.read : ['/'], 'read'),
    el('label', { for: 'u-notes' }, 'Notas'),
    el('input', {
      id: 'u-notes', name: 'notes', value: u.notes, placeholder: 'Agencia, campaña, fecha de fin…',
    }),
    el('div', { class: 'gv-modal-actions' }, el('button', { type: 'button', class: 'gv-btn gv-btn-ghost', onclick: closeModal }, 'Cancelar'), el('button', { type: 'submit', class: 'gv-btn gv-btn-primary' }, editing ? 'Guardar en borrador' : 'Añadir al borrador')),
  );
  return [editing ? `Editar ${editing.name || editing.email}` : 'Nuevo usuario', form];
}

function requestModal() {
  const me = actor();
  const form = el(
    'form',
    { class: 'gv-form', onsubmit: (e) => { e.preventDefault(); submitRequest(new FormData(e.target)); } },
    el('fieldset', { class: 'gv-roles-pick' }, el('legend', {}, 'Rol que necesitas'), Object.entries(ROLES).filter(([id]) => id !== 'admin').map(([id, r]) => el('label', { class: `gv-role-card gv-role-card-${id}` }, el('input', {
      type: 'radio', name: 'role', value: id, checked: (me?.role || 'editor') === id,
    }), el('strong', {}, r.label), el('span', {}, r.description)))),
    el('label', {}, 'Rutas donde necesitas escribir'),
    pathPicker('write', [], 'write'),
    el('label', { for: 'r-reason' }, 'Motivo'),
    el('textarea', {
      id: 'r-reason', name: 'reason', rows: 3, required: true, placeholder: 'Campaña de primavera en /fr hasta el 30 de abril…',
    }),
    el('div', { class: 'gv-modal-actions' }, el('button', { type: 'button', class: 'gv-btn gv-btn-ghost', onclick: closeModal }, 'Cancelar'), el('button', { type: 'submit', class: 'gv-btn gv-btn-primary', disabled: S.busy }, 'Enviar solicitud')),
  );
  return ['Solicitar acceso', form];
}

function confirmModal() {
  const p = pending();
  const body = el(
    'div',
    { class: 'gv-form' },
    el('p', {}, 'Se escribirá en la plataforma:'),
    el(
      'ul',
      { class: 'gv-checks' },
      el('li', { class: 'is-ok' }, icon('check'), `Modelo: ${p.users.length} cambio(s)`),
      el('li', { class: 'is-ok' }, icon('check'), `Hoja permissions de la org: +${p.da.added.length} / −${p.da.removed.length} reglas (solo filas gov:${site()})`),
      el('li', { class: 'is-ok' }, icon('check'), `Roles del sitio: ${p.eds.length} cambio(s)`),
      el('li', { class: 'is-ok' }, icon('lock'), 'El admin protegido conserva /+**, CONFIG y rol admin'),
    ),
    el('p', { class: 'gv-muted' }, 'La plataforma aplica los permisos al momento. Puede que tengas que recargar da.live para verlos.'),
    el('div', { class: 'gv-modal-actions' }, el('button', { type: 'button', class: 'gv-btn gv-btn-ghost', onclick: closeModal }, 'Cancelar'), el('button', { type: 'button', class: 'gv-btn gv-btn-primary', onclick: runApply }, icon('rocket'), 'Aplicar ahora')),
  );
  return ['Aplicar cambios', body];
}

function openUserModal(user) {
  S.modal = { type: 'user', user };
  render();
}

function closeModal() {
  S.modal = null;
  render();
}

function renderModal() {
  if (!S.modal) return null;
  const views = { user: userModal, request: requestModal, confirm: confirmModal };
  const [title, body] = views[S.modal.type]();
  return el(
    'div',
    { class: 'gv-backdrop', onclick: (e) => { if (e.target === e.currentTarget) closeModal(); } },
    el('div', {
      class: 'gv-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
    }, el('header', {}, el('h2', {}, title), el('button', { class: 'gv-btn gv-btn-ghost gv-icon-btn', 'aria-label': 'Cerrar', onclick: closeModal }, icon('x'))), body),
  );
}

/* ---------- Onboarding ---------- */

function viewInit() {
  return el(
    'section',
    { class: 'gv-hero gv-hero-init' },
    el('div', { class: 'gv-orb', 'aria-hidden': 'true' }),
    el(
      'div',
      { class: 'gv-hero-text' },
      el('p', { class: 'gv-eyebrow' }, 'Primer uso'),
      el('h2', {}, 'Pon en marcha el gobierno de accesos'),
      el('p', {}, `Se creará ${USERS_SHEET} en da.live con un administrador protegido: nunca se podrá degradar ni dar de baja, y conservará siempre acceso total a la org y a la config. No se toca la plataforma hasta que pulses Aplicar.`),
      el(
        'form',
        { class: 'gv-form gv-init-form', onsubmit: (e) => { e.preventDefault(); initModel(new FormData(e.target)); } },
        el('label', { for: 'i-email' }, S.me.verified ? 'Tu cuenta (verificada con tu sesión)' : 'Tu email de Adobe ID'),
        el('input', {
          id: 'i-email', name: 'email', type: 'email', required: true, value: S.me.email, readonly: S.me.verified,
        }),
        el('label', { for: 'i-name' }, 'Nombre'),
        el('input', { id: 'i-name', name: 'name', value: S.me.name }),
        el('button', { type: 'submit', class: 'gv-btn gv-btn-primary', disabled: S.busy }, icon('shield'), 'Crear modelo'),
      ),
    ),
  );
}

/* ---------- Layout ---------- */

function tabsFor() {
  const p = S.loading ? { total: 0 } : pending();
  const open = S.requests.filter((r) => ['pendiente', 'preaprobada'].includes(r.status)).length;
  if (amAdmin()) {
    return [
      ['overview', 'Resumen', 'home'],
      ['users', 'Usuarios', 'users'],
      ['matrix', 'Matriz', 'grid'],
      ['sim', 'Simulador', 'flask'],
      ['requests', 'Solicitudes', 'inbox', open],
      ['audit', 'Auditoría', 'list'],
      ['apply', 'Aplicar', 'rocket', p.total],
    ];
  }
  return [
    ['me', 'Mis accesos', 'me'],
    ['requests', canReview() ? 'Solicitudes' : 'Mis solicitudes', 'inbox', canReview() ? open : 0],
    ['matrix', 'Matriz', 'grid'],
    ['sim', 'Simulador', 'flask'],
  ];
}

function go(tab) {
  S.tab = tab;
  render();
}

let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function identityChip() {
  const me = actor();
  return el(
    'div',
    { class: 'gv-me' },
    el('div', { class: 'gv-me-text' }, el('strong', {}, me?.name || S.me.name || S.me.email || 'Sin identificar'), el('span', {}, S.me.email ? `${S.me.email}${S.me.verified ? '' : ' (sin verificar)'}` : 'No se pudo leer tu perfil')),
    me ? avatar(me) : el('span', { class: 'gv-avatar' }, '?'),
  );
}

function render() {
  const app = document.getElementById('app');
  if (!S.ctx) return;
  const focusId = document.activeElement?.id;
  const tabs = S.loading ? [] : tabsFor();
  if (!S.loading && S.modelExists && !tabs.some(([id]) => id === S.tab)) [[S.tab]] = tabs;
  let content;
  if (S.loading) content = el('div', { class: 'gv-loading' }, el('div', { class: 'gv-orb gv-orb-pulse', 'aria-hidden': 'true' }), el('p', {}, 'Leyendo modelo y plataforma…'));
  else if (S.modelError) content = el('p', { class: 'gv-callout gv-callout-bad' }, icon('alert'), `No se pudo leer el modelo: ${S.modelError}`);
  else if (!S.modelExists) content = viewInit();
  else {
    content = {
      overview: viewOverview,
      users: viewUsers,
      matrix: viewMatrix,
      sim: viewSimulator,
      requests: viewRequests,
      audit: viewAudit,
      apply: viewApply,
      me: viewMe,
    }[S.tab]();
  }

  app.replaceChildren(...[
    el(
      'header',
      { class: 'gv-top' },
      el('div', { class: 'gv-brand' }, el('img', {
        src: '/tools/governance/seidor-logo.png', alt: 'Seidor', class: 'gv-logo', width: 130, height: 52,
      }), el('span', { class: 'gv-divider', 'aria-hidden': 'true' }), el('div', {}, el('h1', {}, 'Gobierno y accesos'), el('p', {}, `${S.ctx.org} / ${site()}`))),
      el('div', { class: 'gv-top-right' }, el('button', {
        class: 'gv-btn gv-btn-ghost gv-icon-btn', title: 'Recargar', 'aria-label': 'Recargar', disabled: S.busy, onclick: () => reload(),
      }, icon('refresh')), identityChip()),
    ),
    S.viewAs ? el('div', { class: 'gv-banner' }, icon('eye'), `Estás viendo la app como ${nameOf(S.viewAs)}. Es una simulación: no cambia tu sesión.`, el('button', { class: 'gv-btn gv-btn-ghost', onclick: () => { S.viewAs = ''; S.tab = 'users'; render(); } }, 'Salir')) : null,
    tabs.length ? el('nav', { class: 'gv-tabs', 'aria-label': 'Secciones' }, tabs.map(([id, label, ic, badge]) => el('button', {
      class: `gv-tab ${S.tab === id ? 'is-on' : ''}`, 'aria-current': S.tab === id ? 'page' : null, onclick: () => go(id),
    }, icon(ic), el('span', {}, label), badge ? el('span', { class: 'gv-badge' }, String(badge)) : null))) : null,
    el('main', { class: 'gv-main' }, content),
    !S.loading && amAdmin() && S.tab !== 'apply' && pending().total ? el('div', { class: 'gv-dock' }, el('span', {}, el('span', { class: 'gv-dot' }), `${pending().total} cambio(s) sin aplicar`), el('button', { class: 'gv-btn gv-btn-primary', onclick: () => go('apply') }, 'Revisar y aplicar')) : null,
    S.toast ? el('div', { class: `gv-toast gv-toast-${S.toast.type}`, role: 'status' }, icon(S.toast.type === 'error' ? 'alert' : 'check'), S.toast.text) : null,
    renderModal(),
    el('footer', { class: 'gv-foot' }, 'Seidor · Gobierno de accesos para Experience Workspace y EDS · ', el('a', { href: `https://da.live/#/${S.ctx.org}/${site()}${GOV_FOLDER}`, target: '_blank', rel: 'noopener' }, 'datos del modelo en da.live')),
  ].filter(Boolean));
  if (focusId) document.getElementById(focusId)?.focus();
}

/* ---------- Inicio ---------- */

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.modal) closeModal(); });

(async function init() {
  const sdk = await DA_SDK;
  S.token = sdk.token;
  S.ctx = { ...sdk.context, ref: sdk.context.ref || 'main' };
  render();
  await loadIdentity();
  await reload();
}());
