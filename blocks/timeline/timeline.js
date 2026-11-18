/*
 * Timeline: agenda o itinerario con estado por paso.
 * | Timeline |
 * | Bloque I | ### Título · descripción | Hecho |
 * | Ejercicio 2 | ### Título · descripción | En curso |
 * Celdas: cuándo, contenido, estado (Hecho / En curso / Pendiente).
 * Con una sola celda se toma como contenido; el estado es opcional.
 */

const STATUSES = [
  { key: 'done', pattern: /^(hecho|done|completado|terminado|✔|✓|ok)$/i },
  { key: 'current', pattern: /^(en curso|in progress|ahora|now|actual)$/i },
  { key: 'pending', pattern: /^(pendiente|pending|pr[oó]ximo|todo)$/i },
];

function getStatus(text) {
  const found = STATUSES.find(({ pattern }) => pattern.test(text.trim()));
  return found ? found.key : 'other';
}

export default function decorate(block) {
  const list = document.createElement('ol');
  list.className = 'timeline-list';

  [...block.children].forEach((row) => {
    const cells = [...row.children].filter((cell) => cell.textContent.trim() || cell.querySelector('picture'));
    if (!cells.length) return;

    let when;
    let content;
    let status;
    if (cells.length === 1) [content] = cells;
    else [when, content, status] = cells;

    const statusText = status ? status.textContent.trim() : '';
    const item = document.createElement('li');
    item.className = `timeline-item is-${statusText ? getStatus(statusText) : 'none'}`;

    const marker = document.createElement('span');
    marker.className = 'timeline-marker';
    marker.setAttribute('aria-hidden', 'true');
    item.append(marker);

    if (when) {
      const whenEl = document.createElement('p');
      whenEl.className = 'timeline-when';
      whenEl.textContent = when.textContent.trim();
      item.append(whenEl);
    }

    const body = document.createElement('div');
    body.className = 'timeline-content';
    body.append(...content.childNodes);

    if (statusText) {
      const badge = document.createElement('span');
      badge.className = 'timeline-status';
      badge.textContent = statusText;
      body.prepend(badge);
    }

    item.append(body);
    list.append(item);
  });

  block.replaceChildren(list);
}
