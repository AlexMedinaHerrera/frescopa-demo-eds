/*
 * Profile: tarjeta de presentación.
 * | Profile |
 * | [imagen opcional] | ## Nombre · rol · texto · enlaces |
 * Las celdas pueden faltar o venir en otro orden: se busca la imagen donde esté
 * y todo el texto se junta en el cuerpo. Sin imagen se pintan las iniciales.
 */

function getInitials(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

function isLinkOnly(p) {
  const link = p.querySelector('a');
  return link && p.textContent.trim() === link.textContent.trim();
}

export default function decorate(block) {
  const cells = [...block.querySelectorAll(':scope > div > div')];
  const picture = block.querySelector('picture');

  const body = document.createElement('div');
  body.className = 'profile-body';
  cells
    .filter((cell) => !cell.querySelector('picture') && cell.textContent.trim())
    .forEach((cell) => body.append(...cell.childNodes));

  const heading = body.querySelector('h1, h2, h3, h4, h5, h6');
  if (heading) heading.classList.add('profile-name');

  // Párrafos que solo contienen un enlace -> fila de enlaces
  const linkParagraphs = [...body.querySelectorAll(':scope > p')].filter(isLinkOnly);
  if (linkParagraphs.length) {
    const links = document.createElement('ul');
    links.className = 'profile-links';
    linkParagraphs.forEach((p) => {
      const a = p.querySelector('a');
      a.classList.remove('button', 'primary', 'secondary');
      const li = document.createElement('li');
      li.append(a);
      links.append(li);
      p.remove();
    });
    body.append(links);
  }

  const media = document.createElement('div');
  media.className = 'profile-media';
  if (picture) {
    media.append(picture);
  } else {
    const avatar = document.createElement('span');
    avatar.className = 'profile-initials';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = getInitials(heading ? heading.textContent : body.textContent) || '?';
    media.append(avatar);
  }

  block.replaceChildren(media, body);
}
