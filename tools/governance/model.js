/*
 * Modelo de gobierno: roles, rutas y acciones, sin dependencias del navegador.
 *
 * El modelo (una fila por usuario) se traduce a dos capas que aplica la plataforma:
 *   - DA (Experience Workspace): hoja `permissions` de la config de la org.
 *     Leer / editar por ruta. Solo se tocan las filas etiquetadas `gov:<sitio>`.
 *   - EDS (Admin API): roles del sitio admin / publish / author. Son de todo el sitio.
 * Lo que la plataforma no puede limitar por ruta (preview y publicar) lo aplica la app y
 * queda marcado como "solo modelo" en la matriz y el simulador.
 */

export const GOV_FOLDER = '/governance';
export const USERS_SHEET = `${GOV_FOLDER}/users.json`;
export const AUDIT_SHEET = `${GOV_FOLDER}/audit.json`;
export const REQUESTS_FOLDER = `${GOV_FOLDER}/requests`;

export const ROLES = {
  admin: {
    label: 'Admin plataforma',
    short: 'Admin',
    eds: 'admin',
    description: 'Todo el sitio, la configuración y el propio modelo de gobierno.',
    defaults: { write: ['/'], read: ['/'] },
  },
  publisher: {
    label: 'Publicador / aprobador',
    short: 'Publicador',
    eds: 'publish',
    description: 'Edita y publica en sus rutas. Preaprueba solicitudes de acceso.',
    defaults: { write: ['/'], read: ['/'] },
  },
  editor: {
    label: 'Editor por idioma',
    short: 'Editor',
    eds: 'author',
    description: 'Edita y hace preview en sus rutas (p. ej. /es). Lee el resto.',
    defaults: { write: ['/es'], read: ['/'] },
  },
  reader: {
    label: 'Lector / agencia',
    short: 'Lector',
    eds: null,
    description: 'Solo lectura. Si tiene rutas de escritura (agencia), edita y hace preview solo ahí.',
    defaults: { write: [], read: ['/'] },
  },
};

export const ACTIONS = [
  {
    id: 'read', label: 'Leer', layer: 'DA', scope: 'ruta',
  },
  {
    id: 'edit', label: 'Editar', layer: 'DA', scope: 'ruta',
  },
  {
    id: 'preview', label: 'Preview', layer: 'EDS', scope: 'sitio',
  },
  {
    id: 'publish', label: 'Publicar', layer: 'EDS', scope: 'sitio',
  },
  {
    id: 'config', label: 'Config y apps', layer: 'DA', scope: 'org',
  },
  {
    id: 'approve', label: 'Aprobar solicitudes', layer: 'App', scope: 'app',
  },
  {
    id: 'govern', label: 'Gestionar accesos', layer: 'DA + EDS', scope: 'org',
  },
];

export const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/* ---------- Rutas ---------- */

/** "/es/", "/es/**", "https://…/es/x.html" -> "/es" ; "" o "/" -> "/" */
export function normalizePath(input) {
  let p = String(input || '').trim();
  try {
    if (/^https?:\/\//.test(p)) p = new URL(p).pathname;
  } catch { /* ruta tal cual */ }
  p = p.replace(/\/\+?\*\*$/, '').replace(/\.(html|md|json)$/, '').replace(/\/+$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.toLowerCase() === '/' ? '/' : p.toLowerCase();
}

export const covers = (rule, path) => rule === '/' || path === rule || path.startsWith(`${rule}/`);
const depth = (rule) => (rule === '/' ? 0 : rule.length);

export function splitList(value) {
  return String(value || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

export const uniquePaths = (list) => [...new Set(list.map(normalizePath))].sort();

/* ---------- Usuarios ---------- */

export function cleanUser(raw) {
  const role = ROLES[raw.role] ? raw.role : 'reader';
  return {
    email: String(raw.email || '').trim().toLowerCase(),
    name: String(raw.name || '').trim(),
    role,
    write: uniquePaths(Array.isArray(raw.write) ? raw.write : splitList(raw.write)),
    read: uniquePaths(Array.isArray(raw.read) ? raw.read : splitList(raw.read)),
    status: raw.status === 'baja' ? 'baja' : 'activo',
    protected: raw.protected === true || raw.protected === 'true',
    notes: String(raw.notes || ''),
    updated: raw.updated || '',
    updatedBy: raw.updatedBy || '',
  };
}

export const toRow = (u) => ({
  email: u.email,
  name: u.name,
  role: u.role,
  write: u.write.join(', '),
  read: u.read.join(', '),
  status: u.status,
  protected: String(!!u.protected),
  notes: u.notes,
  updated: u.updated,
  updatedBy: u.updatedBy,
});

export const isActive = (u) => u && u.status === 'activo';
export const isAdmin = (u) => isActive(u) && u.role === 'admin';

/** Rol EDS efectivo: un lector con rutas de escritura (agencia) necesita author para preview */
export function edsRoleOf(u) {
  if (!isActive(u)) return null;
  if (u.role === 'reader') return u.write.length ? 'author' : null;
  return ROLES[u.role].eds;
}

/* ---------- Evaluación según el modelo ---------- */

/** 0 nada, 1 leer, 2 editar. Gana la regla más específica; empate -> la más alta. */
export function accessLevel(u, path) {
  if (!isActive(u)) return { level: 0, rule: null };
  const p = normalizePath(path);
  // Reglas fijas del propio modelo de gobierno
  if (covers(`${GOV_FOLDER}`, p)) {
    if (isAdmin(u)) return { level: 2, rule: `${GOV_FOLDER} (admin)` };
    if (covers(REQUESTS_FOLDER, p)) return { level: 2, rule: `${REQUESTS_FOLDER} (solicitudes)` };
    return { level: 1, rule: `${GOV_FOLDER} (solo lectura)` };
  }
  if (u.role === 'admin') return { level: 2, rule: '/ (admin)' };
  let best = { level: 0, rule: null, d: -1 };
  [[u.write, 2], [u.read, 1]].forEach(([rules, level]) => rules.forEach((rule) => {
    if (!covers(rule, p)) return;
    const d = depth(rule);
    if (d > best.d || (d === best.d && level > best.level)) best = { level, rule, d };
  }));
  return { level: best.level, rule: best.rule };
}

const EDS_CAN = {
  preview: ['author', 'publish', 'admin'],
  publish: ['publish', 'admin'],
};

/** Qué dice el modelo para usuario + acción + ruta, y qué parte la aplica la plataforma */
export function evaluateModel(u, action, path) {
  if (!u) return { allowed: false, reason: 'El usuario no está en el modelo.' };
  if (!isActive(u)) return { allowed: false, reason: 'Usuario dado de baja.' };
  const { level, rule } = accessLevel(u, path);
  const role = edsRoleOf(u);
  const via = rule ? `regla ${rule}` : 'ninguna regla de ruta';
  switch (action) {
    case 'read':
      return { allowed: level >= 1, reason: level >= 1 ? `Lectura por ${via}.` : 'No tiene ninguna ruta que cubra esta.' };
    case 'edit':
      return { allowed: level >= 2, reason: level >= 2 ? `Escritura por ${via}.` : `Solo ${level ? 'lectura' : 'sin acceso'} (${via}).` };
    case 'preview':
    case 'publish': {
      const roleOk = EDS_CAN[action].includes(role);
      const pathOk = level >= 2;
      let reason;
      if (!roleOk) reason = `Su rol (${ROLES[u.role].short}) no permite ${action === 'publish' ? 'publicar' : 'preview'}.`;
      else if (!pathOk) reason = `Su rol lo permite, pero el modelo limita ${action === 'publish' ? 'publicar' : 'preview'} a sus rutas de escritura.`;
      else reason = `Rol ${role} + escritura por ${via}.`;
      return { allowed: roleOk && pathOk, reason };
    }
    case 'config':
    case 'govern':
      return { allowed: isAdmin(u), reason: isAdmin(u) ? 'Admin de plataforma.' : 'Solo administradores.' };
    case 'approve':
      return {
        allowed: ['admin', 'publisher'].includes(u.role),
        reason: { admin: 'Aprueba y aplica.', publisher: 'Preaprueba; un admin aplica.' }[u.role] || 'Solo admin o publicador.',
      };
    default:
      return { allowed: false, reason: 'Acción desconocida.' };
  }
}

/* ---------- Capa DA: hoja permissions ---------- */

export const daTag = (site) => `gov:${site}`;
const daPath = (site, p) => (p === '/' ? `/${site}/+**` : `/${site}${p}/+**`);

/** Filas que el modelo quiere en la hoja permissions (todas etiquetadas) */
export function buildDaRows(users, site) {
  const tag = daTag(site);
  const buckets = new Map();
  const add = (path, actions, email, comment = tag) => {
    const key = `${path}|${actions}|${comment}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        path, actions, comment, emails: new Set(),
      });
    }
    buckets.get(key).emails.add(email);
  };
  users.filter(isActive).forEach((u) => {
    if (u.role === 'admin') {
      add(daPath(site, '/'), 'write', u.email);
      add(daPath(site, GOV_FOLDER), 'write', u.email);
      add('CONFIG', 'write', u.email);
    } else {
      u.write.forEach((p) => add(daPath(site, p), 'write', u.email));
      u.read.filter((p) => !u.write.some((w) => covers(w, p) && depth(w) >= depth(p)))
        .forEach((p) => add(daPath(site, p), 'read', u.email));
      add(daPath(site, GOV_FOLDER), 'read', u.email);
      add('CONFIG', 'read', u.email);
    }
    add(daPath(site, REQUESTS_FOLDER), 'write', u.email);
    // Red de seguridad: el admin protegido conserva toda la org y la config pase lo que pase
    if (u.protected) add('/+**', 'write', u.email, `${tag}:protect`);
  });
  return [...buckets.values()]
    .map(({
      path, actions, comment, emails,
    }) => ({
      path, groups: [...emails].sort().join(', '), actions, comments: comment,
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.actions.localeCompare(b.actions));
}

const rowKey = (r) => `${r.path}|${r.actions}|${splitList(r.groups).map((g) => g.toLowerCase()).sort().join(',')}`;

export const isManagedRow = (row, site) => String(row.comments || '').startsWith(daTag(site));

/** Mantiene intactas las filas de otros sitios o manuales; sustituye las gestionadas */
export function mergeDaRows(current, generated, site) {
  // Si otra herramienta (p. ej. la pantalla Permissions de da.live) reescribió una fila del
  // modelo sin la etiqueta, no se duplica: la versión etiquetada la sustituye
  const wanted = new Set(generated.map(rowKey));
  const kept = (current || [])
    .filter((row) => !isManagedRow(row, site) && !wanted.has(rowKey(row)));
  return [...kept, ...generated];
}

export function diffRows(before, after) {
  const a = new Map((before || []).map((r) => [rowKey(r), r]));
  const b = new Map((after || []).map((r) => [rowKey(r), r]));
  return {
    added: [...b].filter(([k]) => !a.has(k)).map(([, r]) => r),
    removed: [...a].filter(([k]) => !b.has(k)).map(([, r]) => r),
  };
}

/** Filas manuales (no gestionadas) que también afectan a este sitio */
export function foreignSiteRows(rows, site) {
  return (rows || []).filter((r) => !isManagedRow(r, site)
    && (String(r.path).startsWith(`/${site}/`) || r.path === `/${site}` || r.path === '/+**' || r.path === '/**' || r.path === 'CONFIG'));
}

/** CONFIG de la org o CONFIG del sitio (/<sitio>/CONFIG, lo que escribe la pantalla Permissions) */
export const isConfigPath = (p, site) => ['CONFIG', `/${site}/CONFIG`].includes(String(p || '').trim());

/** "/site/es/+**" -> "/es" ; "/site/+**" o "/+**" -> "/" ; otra cosa -> null */
function rowToPath(rowPath, site) {
  const p = String(rowPath || '').trim();
  if (p === '/+**' || p === '/**') return '/';
  if (p !== `/${site}` && !p.startsWith(`/${site}/`)) return null;
  return normalizePath(p.slice(site.length + 1) || '/');
}

/**
 * Personas con acceso real (reglas DA manuales o roles EDS) que no están en el modelo.
 * Los grupos IMS (OrgID/GroupID) no son emails y se ignoran.
 */
export function externalUsers(users, daRows, edsRole, site) {
  const known = new Set(users.map((u) => u.email));
  const found = new Map();
  const get = (email) => {
    const key = email.toLowerCase();
    if (!found.has(key)) {
      found.set(key, {
        email: key,
        sources: new Set(),
        eds: new Set(),
        write: new Set(),
        read: new Set(),
        config: false,
      });
    }
    return found.get(key);
  };
  foreignSiteRows(daRows, site).forEach((row) => {
    const emails = splitList(row.groups)
      .filter((g) => EMAIL_RE.test(g) && !known.has(g.toLowerCase()));
    emails.forEach((g) => {
      const x = get(g);
      x.sources.add('DA');
      if (isConfigPath(row.path, site)) {
        x.config = x.config || splitList(row.actions).includes('write');
        return;
      }
      const path = rowToPath(row.path, site);
      if (!path) return;
      x[splitList(row.actions).includes('write') ? 'write' : 'read'].add(path);
    });
  });
  Object.entries(edsRole || {}).forEach(([role, list]) => (list || []).forEach((email) => {
    if (!EMAIL_RE.test(email) || known.has(String(email).toLowerCase())) return;
    const x = get(email);
    x.sources.add('EDS');
    x.eds.add(role);
  }));
  return [...found.values()].map((x) => {
    let role = 'reader';
    if (x.eds.has('admin') || x.config) role = 'admin';
    else if (x.eds.has('publish')) role = 'publisher';
    else if (x.eds.has('author') || x.write.size) role = 'editor';
    const write = [...x.write];
    return {
      email: x.email,
      sources: [...x.sources],
      eds: [...x.eds],
      write: role === 'editor' && !write.length ? [] : write,
      read: x.read.size ? [...x.read] : ['/'],
      suggestedRole: role,
    };
  }).sort((a, b) => a.email.localeCompare(b.email));
}

function patternMatch(pattern, full) {
  if (pattern.endsWith('/+**')) {
    const base = pattern.slice(0, -4);
    return base === '' || full === base || full.startsWith(`${base}/`);
  }
  if (pattern.endsWith('/**')) return full.startsWith(`${pattern.slice(0, -3)}/`);
  return full === pattern;
}

/**
 * Simula la hoja permissions real para un email y una ruta del sitio.
 * null = no hay hoja (DA no restringe por rutas).
 */
export function evaluateDaRows(rows, email, site, path) {
  if (!rows) return null;
  const me = email.toLowerCase();
  const mine = rows.filter((r) => splitList(r.groups).some((g) => g.toLowerCase() === me));
  if (path === 'CONFIG') {
    // La regla del sitio es más específica que la de la org
    const cfg = mine.filter((r) => String(r.path).trim() === `/${site}/CONFIG`);
    const best = cfg.length ? cfg : mine.filter((r) => String(r.path).trim() === 'CONFIG');
    if (!best.length) return { level: 0, rule: null };
    const acts = best.flatMap((r) => splitList(r.actions));
    let level = acts.includes('read') ? 1 : 0;
    if (acts.includes('write')) level = 2;
    return { level, rule: best[0].path };
  }
  const full = `/${site}${normalizePath(path) === '/' ? '' : normalizePath(path)}`;
  const matches = mine.filter((r) => patternMatch(String(r.path).trim(), full));
  if (!matches.length) return { level: 0, rule: null };
  const spec = (r) => String(r.path).replace(/\/\+?\*\*$/, '').length;
  const top = Math.max(...matches.map(spec));
  const best = matches.filter((r) => spec(r) === top);
  const write = best.some((r) => splitList(r.actions).includes('write'));
  const read = write || best.some((r) => splitList(r.actions).includes('read'));
  let level = read ? 1 : 0;
  if (write) level = 2;
  return { level, rule: best[0].path };
}

/* ---------- Capa EDS: roles del sitio ---------- */

export const EDS_ROLES = ['admin', 'publish', 'author'];

/** Conserva emails ajenos al modelo; los del modelo quedan en su rol (o en ninguno si baja) */
export function buildEdsRoles(users, currentRole = {}) {
  const modelEmails = new Set(users.map((u) => u.email));
  const role = {};
  Object.entries(currentRole || {}).forEach(([name, list]) => {
    role[name] = (list || []).filter((e) => !modelEmails.has(String(e).toLowerCase()));
  });
  users.forEach((u) => {
    const r = u.protected ? 'admin' : edsRoleOf(u);
    if (!r) return;
    role[r] = [...(role[r] || []), u.email];
  });
  Object.keys(role).forEach((name) => {
    role[name] = [...new Set(role[name])].sort();
    if (!role[name].length) delete role[name];
  });
  return role;
}

export function diffRoles(before = {}, after = {}) {
  const changes = [];
  new Set([...Object.keys(before || {}), ...Object.keys(after || {})]).forEach((name) => {
    const a = new Set(before?.[name] || []);
    const b = new Set(after?.[name] || []);
    [...b].filter((e) => !a.has(e)).forEach((email) => changes.push({ type: 'add', role: name, email }));
    [...a].filter((e) => !b.has(e)).forEach((email) => changes.push({ type: 'remove', role: name, email }));
  });
  return changes;
}

export function edsAllows(roleMap, email, action) {
  if (!roleMap || !Object.keys(roleMap).length) return null;
  const mine = Object.entries(roleMap)
    .filter(([, list]) => (list || []).some((e) => String(e).toLowerCase() === email.toLowerCase()))
    .map(([name]) => name);
  return EDS_CAN[action].some((r) => mine.includes(r));
}

/* ---------- Cambios en el modelo ---------- */

const FIELDS = ['name', 'role', 'write', 'read', 'status', 'notes'];

export function diffUsers(before, after) {
  const a = new Map(before.map((u) => [u.email, u]));
  const changes = [];
  after.forEach((u) => {
    const old = a.get(u.email);
    if (!old) {
      changes.push({ type: 'alta', email: u.email, fields: [] });
      return;
    }
    const fields = FIELDS.filter((f) => JSON.stringify(old[f]) !== JSON.stringify(u[f]));
    if (fields.length) {
      changes.push({
        type: 'cambio', email: u.email, fields, before: old, after: u,
      });
    }
  });
  return changes;
}

export function describeChange(c, users) {
  const u = users.find((x) => x.email === c.email);
  if (c.type === 'alta') return `Alta de ${c.email} como ${ROLES[u.role].short} (escritura: ${u.write.join(', ') || '—'})`;
  return c.fields.map((f) => {
    const show = (v) => (Array.isArray(v) ? v.join(', ') || '—' : (f === 'role' ? ROLES[v]?.short : v) || '—');
    return `${c.email}: ${f} ${show(c.before[f])} → ${show(c.after[f])}`;
  }).join(' · ');
}

/* ---------- Hojas de DA ---------- */

export const sheetRows = (json) => (json && Array.isArray(json.data) ? json.data : []);

export const toSheet = (rows) => ({
  total: rows.length, limit: rows.length, offset: 0, data: rows, ':type': 'sheet',
});
