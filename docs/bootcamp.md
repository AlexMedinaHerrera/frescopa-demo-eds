# Bootcamp EDS: contexto, decisiones y lecciones aprendidas

Guía de lo que se ha montado sobre la plantilla `JorgeRZT/edsfrescopa` durante el bootcamp: cómo se creó el sitio, qué se ha desarrollado, qué configuración vive fuera de Git, las preguntas que surgieron (con su respuesta) y los errores de los que conviene aprender.

| | |
|---|---|
| Repo | https://github.com/AlexMedinaHerrera/frescopa-demo-eds |
| Contenido (Experience Workspace) | https://da.live/#/alexmedinaherrera/frescopa-demo-eds |
| Preview | https://main--frescopa-demo-eds--alexmedinaherrera.aem.page/ |
| Live | https://main--frescopa-demo-eds--alexmedinaherrera.aem.live/ |
| Panel de integraciones | https://da.live/app/alexmedinaherrera/frescopa-demo-eds/tools/integrations |
| Panel QA | https://da.live/app/alexmedinaherrera/frescopa-demo-eds/tools/qa |
| Gobierno y accesos | https://da.live/app/alexmedinaherrera/frescopa-demo-eds/tools/governance ([docs](governance.md)) |
| Publicaciones programadas | https://da.live/apps/scheduler |

---

## 1. Cómo se montó el sitio

1. **Repo desde la plantilla.** *Use this template* sobre `JorgeRZT/edsfrescopa`. No vale otro boilerplate: un primer intento partió de `adobe/aem-boilerplate` y no tenía `demo-content/` ni los scripts `seed:content` y `setup:integrations` (ver [lecciones](#7-lecciones-aprendidas)).
2. **AEM Code Sync** instalado con acceso solo a este repo.
3. **Sitio en da.live** desde `da.live/start`, con *sin contenido demo*. Resultado: contenido en `https://content.da.live/alexmedinaherrera/frescopa-demo-eds/`.
4. **Token IMS** para los scripts:
   ```
   npx.cmd -y github:adobe-rnd/da-auth-helper token
   ```
   Queda en `~/.aem/da-token.json`. En PowerShell usa `npx.cmd`: `npx` falla si la política de ejecución de scripts está deshabilitada.
5. **Contenido de Fréscopa** (182 ficheros, Library de Blocks/Templates/Icons y 11 redirects):
   ```
   npm ci
   ORG=alexmedinaherrera SITE=frescopa-demo-eds npm run seed:content
   ```
6. **Integraciones del sitio** (buscador, sitemaps, `robots.txt`, json2html, overlay de BYOM):
   ```
   ORG=alexmedinaherrera SITE=frescopa-demo-eds npm run setup:integrations
   ```
7. **Comprobación:** home, `/integrations/byom` y `/integrations/json2html` responden 200 en preview, y `/cafe` hace 301 a `/coffee`.

---

## 2. Qué se ha desarrollado

### 2.1 Bloques custom

| Bloque | Tabla en el documento | Qué hace |
|---|---|---|
| [`profile`](../blocks/profile/profile.js) | `Profile` → [imagen opcional] \| nombre, rol, texto, enlaces | Tarjeta de presentación. Sin foto pinta las iniciales; los párrafos que solo son un enlace pasan a una fila de botones. |
| [`stats`](../blocks/stats/stats.js) | `Stats` → cifra \| etiqueta (una fila por cifra) | Cifras que cuentan desde 0 al entrar en pantalla. Admite prefijo y sufijo (`+30`, `95 %`). Variante `Stats (dark)`. Respeta *reduce motion* y los lectores de pantalla leen la cifra final. |
| [`timeline`](../blocks/timeline/timeline.js) | `Timeline` → cuándo \| contenido \| estado | Itinerario con estado *Hecho* / *En curso* / *Pendiente*. |

Los tres decoran a la defensiva (el autor puede omitir o añadir celdas) y usan los tokens de Fréscopa (`--frescopa-color-*`; ojo, `1rem = 10px`).

Página de ejemplo: [/formacion/alex-medina](https://main--frescopa-demo-eds--alexmedinaherrera.aem.page/formacion/alex-medina).

También están en la **Library** de da.live (`/docs/library/blocks/{profile,stats,timeline}`) con su tabla `fields` para el Block Inspector.

### 2.2 Block Inspector (extensión de Adobe)

Panel lateral de propiedades para editar un bloque como un formulario en lugar de tocar la tabla. Es la extensión `adobe-rnd/ew-extensions/tools/block-editor`, dada de alta como fila de la hoja `library` del sitio.

Requisitos para que un bloque sea editable:
- Estar en la Library de Blocks.
- Tener una tabla `fields` en su *Library Metadata*: primera fila `fields` y luego filas que replican la estructura del bloque, un párrafo por campo. Se puede generar con **Generate fields** (IA) desde el propio panel.
- Para bloques de filas repetidas, una fila en la hoja `editor` del índice de la Library: `stats | multi`, `timeline | multi`.

> **El Block Inspector lee el índice de la Library desde `aem.live`.** Si `/docs/library/blocks.json` no está publicado, dice que *no hay Library configurada*.

### 2.3 Panel de integraciones por entorno

Activa scripts de terceros (Gigya, Salesforce…) por entorno, sin desplegar código.

| Pieza | Dónde |
|---|---|
| Catálogo de integraciones, detección de entorno, reglas de rutas y cargador | [`scripts/integrations.js`](../scripts/integrations.js) |
| Carga de las integraciones a los ~3 s (no afecta a Lighthouse) | [`scripts/delayed.js`](../scripts/delayed.js) |
| Panel (app de da.live) | [`tools/integrations.html`](../tools/integrations.html), [`tools/integrations/`](../tools/integrations/integrations.js) |
| Configuración | Hojas de da.live `/config/integrations/{gigya,salesforce,badge}` |

**Modelo:**
- **Entorno = rama**, como los run modes de AEM. `develop--…aem.page` usa la columna `develop`, `stage--…` la de `stage`, y `main--…` y el dominio de producción la de `main`. Las ramas feature y `localhost` usan `develop`.
- **Una hoja por integración** con filas `key` y una columna por entorno (`develop | stage | main`). Así cada integración tiene permisos de edición propios y se publica por separado.
- **Aplicar** = guardar la hoja y hacer preview. Afecta a desarrollo, stage y pre-producción (`aem.page`).
- **Publicar en producción** = publicar la hoja. La columna `main` llega a `aem.live` y al dominio final.
- **Reglas de rutas** por entorno: *Solo en rutas* (`/account/**, /checkout/**`) y *Excepto rutas* (`/es/legal/**`). `/x/**` incluye `/x` y todo lo que cuelga; `*` no cruza `/`.
- **Permisos reales:** el panel lee `X-da-actions` (editar en da.live) y `admin.hlx.page/status` (`preview.permissions` / `live.permissions`) y desactiva los botones que no puedes usar, explicando el motivo. La plataforma es quien lo aplica.

**Integraciones incluidas:**
- **SAP Customer Data Cloud (Gigya):** API key y **data center**. El data center es la región donde el cliente creó su sitio de Gigya (`eu1` por GDPR, `us1`, `au1`). El SDK se carga desde el CDN de esa región (`cdns.eu1.gigya.com`…); con la región equivocada la API key se rechaza. Para otra región, añade una línea a `GIGYA_HOSTS`.
- **Salesforce Marketing Cloud Personalization:** account y dataset (salen de la URL del beacon `cdn.evgnet.com/beacon/{account}/{dataset}/…`).
- **Distintivo de validación:** recuadro en la página con el entorno y las integraciones cargadas (✔/✖). Activo en `develop` y `stage`, nunca en producción.

**Añadir una integración:** una entrada en `INTEGRATIONS` (`id`, `fields`, `src`) y su hoja `/config/integrations/<id>`. El panel la muestra sola. Las URLs de los scripts se construyen en el código: desde la hoja no se puede inyectar un script arbitrario.

> Las hojas son **públicas**: solo claves públicas, nunca secretos. Lo que necesite un secreto (OAuth de Salesforce, APIs de servidor) va en un backend: edge function de la CDN, App Builder o un endpoint propio.

### 2.4 Panel QA

App de da.live y botón **QA** en la Sidekick ([`tools/qa.html`](../tools/qa.html), [`tools/qa/qa.js`](../tools/qa/qa.js), [`tools/sidekick/config.json`](../tools/sidekick/config.json)). Por cada ruta comprueba enlaces e imágenes rotas (incluidos nav y footer), SEO (title, description, og:image, noindex, h1), accesibilidad (alt, textos de enlace), contenido pendiente (lorem ipsum, enlaces a preview), idiomas y la hoja `/redirects.json`. Exporta CSV.

Solo puede leer estados HTTP de su mismo origen (`aem.page` no envía CORS), así que valida la rama desde la que se sirve. Por eso en el editor se carga desde `main--…aem.page`.

### 2.5 Publicación programada (de serie)

No hace falta código: Experience Workspace la trae.

1. **Activar** la opción: fila `Schedule Publish` en la hoja `prepare` de la configuración del sitio (hecho).
2. **Registrar** el sitio una vez (un administrador): `da.live/apps/scheduler` → `/alexmedinaherrera/frescopa-demo-eds/` → *Load schedules* → *Register site* (hecho).
3. **Programar:** abrir la página u hoja en EW → **Prepare → Schedule publish** → fecha y hora → *Schedule*.
4. **Ver o cancelar:** `da.live/apps/scheduler` → *Load schedules* → *Open* / *Delete* (sin confirmación).

**Prueba realizada:** `/formacion/prueba-programada` estaba solo en preview (404 en live). Programada desde EW, se publicó a las 16:36 (hora de Madrid) por `helix@adobe.com`, el servicio planificador.

A tener en cuenta:
- Publica el contenido **tal como esté a la hora programada**. Para congelar lo revisado, usa un **snapshot** (sirve también para lanzar varias páginas a la vez).
- Al programar, EW hace preview automáticamente.
- El planificador revisa la cola **cada 5 minutos**: programa con margen.
- Las hojas también se pueden programar. Ejemplo: dejar preparada la columna Producción de `/config/integrations/gigya` y programar su publicación = "activar Gigya en producción el lunes a las 9".

---

## 3. Configuración que vive fuera de Git

Git solo guarda el código. Esto se ha configurado directamente en da.live o en la Admin API y **no se recupera con un `git clone`**:

| Qué | Dónde | Contenido |
|---|---|---|
| Hoja `library` | Config del sitio en da.live (`admin.da.live/config/alexmedinaherrera/frescopa-demo-eds/`) | Blocks, Templates, Icons, **Block Inspector**, **Integraciones** (diálogo), **Panel QA** (diálogo) |
| Hoja `apps` | Misma config | Tarjetas *Integraciones por entorno* y *Panel QA* en la sección Apps |
| Hoja `prepare` | Misma config | `Schedule Publish` |
| Índice de bloques | `/docs/library/blocks.json` (multi-sheet `data` + `editor`), **publicado** | 27 bloques; `stats` y `timeline` como `multi` |
| Docs de la Library | `/docs/library/blocks/{profile,stats,timeline}` | Plantilla del bloque + `fields` |
| Hojas de integraciones | `/config/integrations/{gigya,salesforce,badge}`, en preview y live | Columnas `develop \| stage \| main` |
| Cabecera CORS | Admin API: `config/alexmedinaherrera/sites/frescopa-demo-eds/headers.json` | `access-control-allow-origin: *` para `/config/integrations/**` |
| Modelo de gobierno | `/governance/` en da.live + hoja `permissions` de la org + roles del sitio | Usuarios, solicitudes, auditoría; ver [governance.md](governance.md) |
| Scheduler | Servicio de Adobe | Sitio registrado |
| Ramas de entorno | GitHub | `main`, `develop`, `stage` (y `panel-qa`, ya integrada en `main`) |

Si se recrea el sitio, hay que repetir esta tabla. Candidato a script, como `setup:integrations`.

---

## 4. Ciclo de trabajo

- **Código:** commit en una rama → Code Sync la publica en `{rama}--frescopa-demo-eds--alexmedinaherrera.aem.page` → merge a `main` = despliegue. El código no se "publica": está en `aem.page` y `aem.live` de cada rama.
- **Contenido:** se edita en EW → **Preview** (`aem.page`) → **Publish** (`aem.live` y producción). Un 404 en `aem.page` casi siempre es *falta hacer preview*.
- **Ver lo que recibe EDS:** añade `.md` o `.plain.html` a la URL.
- **Probar en local:** `npx -y @adobe/aem-cli up` (código local + contenido en preview, en `localhost:3000`).

---

## 5. Preguntas y respuestas

**¿Qué run modes tiene EDS?**
Ninguno. No hay instancias author/publish ni OSGi. El "entorno" es la URL: local (`localhost:3000`), preview (`.aem.page`), live (`.aem.live`) y producción (dominio propio tras la CDN). Cada rama de Git es un entorno (`{rama}--repo--owner`). Si algo debe comportarse distinto, se decide en el JS mirando el host, o con una hoja que tenga versión preview y live.

**¿Cómo se integra Salesforce o Gigya, y cómo se activa solo en stage para validar?**
Como JavaScript en el navegador, cargado en `delayed.js`, en un bloque o bajo demanda, nunca en la fase eager. Para activarlo por entorno sin desplegar: una hoja de configuración (preview = stage, publicada = producción) o, como en este repo, columnas por rama. Hay que dar de alta `*.aem.page`, `*.aem.live` y el dominio final como dominios de confianza en Gigya y en Salesforce.

**¿Qué es una edge function?**
Código que se ejecuta en la CDN, en el nodo más cercano al usuario, interceptando peticiones y respuestas: guardar secretos, autenticar, cabeceras, A/B, proxy a APIs. En EDS no se puede ejecutar código en `aem.page` ni `aem.live`: vive en la CDN de producción (la del cliente o la gestionada de Adobe). Ver [edge-workers.md](edge-workers.md).

**¿Qué plugins custom tiene sentido crear?**
Los que no trae la plataforma: selector de productos del PIM, comprobaciones SEO y de accesibilidad antes de publicar (el Panel QA va en esa línea), ayuda con redirecciones al mover páginas, estado de traducciones y el panel de integraciones por entorno. Antes de construir, comprueba qué trae ya da.live: cambia rápido.

**¿Cómo activo una integración en un entorno u otro desde el panel?**
Rellena la columna del entorno y pulsa **Aplicar** (desarrollo, stage y pre-producción). Para producción, **Publicar en producción**. No se puede tener algo en producción que no haya pasado por preview.

**¿Se pueden restringir los accesos?**
Sí, y lo aplica la plataforma:
- *Quién aplica o publica:* roles del sitio en la Admin API (`author` hace preview, `publish` publica).
- *Quién edita cada integración:* permisos de da.live por documento (por eso hay una hoja por integración).
- *Dónde se carga:* reglas de rutas en el panel.
- *Quién ve la preview:* `access.preview.allow` en la config del sitio (implica adaptar el panel, que hoy lee la preview sin sesión).

La app **Gobierno y accesos** ([governance.md](governance.md)) gestiona roles y rutas por usuario y los aplica en la plataforma.

**¿Hay publicación programada de serie?**
Sí (sección 2.5). Un plugin propio solo tendría sentido para huecos: aprobaciones, calendario editorial multisitio, disparadores externos (Admin API desde una GitHub Action).

**¿Experience Workspace y Document Authoring son lo mismo?**
EW es la interfaz de autoría; el contenido se guarda en DA (`content.da.live`). Las guías de EW aplican tal cual. Si el contenido viniera de AEM Sites (Universal Editor), la programación se haría en AEM Author con *Manage Publication*.

**¿Por qué no salen mis plugins en *Panels → Extensions*?**
Ese menú solo muestra lo que está en la hoja `library` de la config del sitio. Una app de da.live (`da.live/app/…`) no aparece hasta que se da de alta ahí (y en la hoja `apps` para la sección Apps).

---

## 6. Pendientes

- [ ] La página `/formacion/alex-medina` usa una tabla `highlight` que **no existe como bloque** (da un 404 al cargar su JS). Sustituirla por *Section Metadata* con `Style: highlight`.
- [ ] El bloque `profile` de esa página tiene textos de ejemplo.
- [ ] Inicializar la app de gobierno, dar de alta la cuenta de prueba y aplicar (ver [governance.md](governance.md#prueba-con-dos-cuentas)). Más adelante, pasar a grupos de Admin Console.
- [ ] Decidir si se protege la preview (`access.preview.allow`) y adaptar el panel para leerla con sesión.
- [ ] Confirmar en qué zona horaria trabaja el diálogo *Schedule publish*.
- [ ] Borrar `/formacion/prueba-programada` si no se quiere en el sitio público.
- [ ] Generar `fields` para los 24 bloques de Fréscopa (Generate fields en el Block Inspector).
- [ ] Borrar la rama `panel-qa` (integrada en `main`).
- [ ] Script que recree la configuración de la sección 3.

---

## 7. Lecciones aprendidas

### Montaje
- **Partir de la plantilla correcta.** El primer repo (`eds-poc-bootcamp`) salió de `adobe/aem-boilerplate` y no tenía ni el contenido demo ni los scripts. Se rehízo desde `JorgeRZT/edsfrescopa`.
- **PowerShell bloquea `npx.ps1`.** Usa `npx.cmd` o `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **Un 404 en `aem.page` es casi siempre "falta preview".**

### EDS y da.live
- **Las respuestas JSON de EDS no traen CORS.** Un panel que lee `aem.page` y `aem.live` a la vez necesita una cabecera en la config del sitio, limitada a la ruta que lo necesita.
- **El navegador cachea las hojas 60 s** (`max-age=60`). Tras aplicar o publicar, recarga con Ctrl+F5 o usa incógnito antes de concluir que no ha funcionado.
- **El contenido es común a todas las ramas.** Una configuración "por rama" no se consigue con ramas de contenido, sino guardando valores por rama en la hoja y eligiendo según el host.
- **Lo que lee una extensión, ¿preview o live?** El Block Inspector lee la Library de `aem.live`: sin publicar, no la encuentra.
- **La Library acepta índices multi-sheet** (`data` + `editor` + `options`).
- **Code Sync tarda unos segundos.** Al comprobarlo con `curl`, recuerda que la respuesta va comprimida (`--compressed`).

### Código
- **`replaceChildren` no aplana arrays:** pasar `INTEGRATIONS.map(...)` sin `...` pintó `[object HTMLElement]`.
- **No escribir si no se pudo leer.** Una versión del panel permitía "Aplicar" aunque fallase la lectura del borrador, lo que habría sobrescrito la hoja con valores por defecto. Ahora se bloquea.
- **Publicar debe ser por unidad.** Con una sola hoja, promocionar una integración arrastraba las demás. Una hoja por integración lo evita.
- **Las URLs de terceros se construyen en código**, nunca se leen tal cual de una hoja editable.

### Proceso
- **Verificar con un navegador real.** Renderizar con Edge en modo headless (`--dump-dom`, `--screenshot`) detectó el distintivo ilegible y confirmó cada entorno, cosa que un `curl` no ve.
- **Los textos con tildes no deben pasar por la consola de Windows.** Un `curl --form-string "$(cat …)"` guardó `producci�n`. Enviar desde Node (`fetch` + `FormData`) lo resuelve.
- **Varias sesiones sobre el mismo checkout se pisan.** Otra sesión dejó el repo en la rama `panel-qa` y un commit acabó ahí en vez de en `main`. Antes de commitear, mira `git status -sb`. Para trabajar en paralelo, usa worktrees.
- **Al copiar una columna de entorno, revisa qué copias.** Duplicar `develop` en un entorno nuevo arrastró una API key de prueba. Producción no se vio afectada, pero se publicó una configuración no deseada.
- **Ante una instrucción ambigua, pregunta.** "Añade también la de qa" era el Panel QA, no un entorno QA.
- **Guarda copia antes de tocar configuración** (la del sitio, la Library, las hojas). Se hizo en cada cambio y permitió deshacer sin perder nada.

---

## 8. Referencias

- [Scheduled Publishing (developer)](https://www.aem.live/developer/scheduling) · [Schedule Publish (EW)](https://www.aem.live/docs/ew/administering/schedule-publish) · [helix-snapshot-scheduler](https://github.com/adobe/helix-snapshot-scheduler)
- [Block Inspector (ew-extensions)](https://github.com/adobe-rnd/ew-extensions/blob/main/tools/block-editor/README.md)
- [DA App SDK: apps y plugins](https://docs.da.live/developers/guides/developing-apps-and-plugins)
- Documentación de este repo: [architecture](architecture.md), [BYOM](byom.md), [json2html](json2html.md), [redirects](redirects.md), [search and sitemaps](search-and-sitemaps.md), [edge workers](edge-workers.md), [private area](private-area.md)
