/*
 * Stats: cifras grandes que cuentan desde 0 al entrar en pantalla.
 * | Stats |
 * | 182 | Ficheros subidos |
 * | +30 | Bloques |
 * Primera celda: la cifra (admite prefijo y sufijo: "+30", "95 %", "17 min").
 * Segunda celda (opcional): la etiqueta. Variante: Stats (dark).
 */

const NUMBER = /^(\D*?)(\d[\d.,]*)(.*)$/s;

function parseValue(text) {
  const match = text.trim().match(NUMBER);
  if (!match) return null;
  const [, , raw] = match;
  // "4,5" o "4.25" -> decimal; "1.200" o "1,200" -> separador de miles
  const decimal = raw.match(/[.,](\d{1,2})$/);
  if (decimal) {
    const intPart = raw.slice(0, -decimal[0].length).replace(/[.,]/g, '');
    return { target: Number(`${intPart}.${decimal[1]}`), decimals: decimal[1].length };
  }
  return { target: Number(raw.replace(/[.,]/g, '')), decimals: 0 };
}

function countUp(el, finalText, { target, decimals }) {
  const prefixSuffix = finalText.trim().match(NUMBER);
  const [, prefix, , suffix] = prefixSuffix;
  const format = new Intl.NumberFormat(document.documentElement.lang || undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const duration = 1400;
  let start;
  const step = (now) => {
    if (start === undefined) start = now;
    const progress = Math.min((now - start) / duration, 1);
    if (progress < 1) {
      const eased = 1 - (1 - progress) ** 3;
      el.textContent = `${prefix}${format.format(target * eased)}${suffix}`;
      window.requestAnimationFrame(step);
    } else {
      el.textContent = finalText;
    }
  };
  window.requestAnimationFrame(step);
}

export default function decorate(block) {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const list = document.createElement('ul');
  list.className = 'stats-list';

  [...block.children].forEach((row) => {
    const [valueCell, labelCell] = row.children;
    const valueText = valueCell ? valueCell.textContent.trim() : '';
    if (!valueText) return;

    const item = document.createElement('li');
    item.className = 'stats-item';

    const value = document.createElement('p');
    value.className = 'stats-value';
    // Texto final para lectores de pantalla; la animación es solo visual
    const srText = document.createElement('span');
    srText.className = 'stats-sr';
    srText.textContent = valueText;
    const number = document.createElement('span');
    number.className = 'stats-number';
    number.setAttribute('aria-hidden', 'true');
    number.textContent = valueText;
    value.append(srText, number);
    item.append(value);

    if (labelCell && labelCell.textContent.trim()) {
      const label = document.createElement('div');
      label.className = 'stats-label';
      label.append(...labelCell.childNodes);
      item.append(label);
    }

    const parsed = parseValue(valueText);
    if (parsed && !reduceMotion && 'IntersectionObserver' in window) {
      number.textContent = valueText.replace(/\d[\d.,]*/, '0');
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          countUp(number, valueText, parsed);
        }
      }, { threshold: 0.4 });
      observer.observe(item);
    }

    list.append(item);
  });

  block.replaceChildren(list);
}
