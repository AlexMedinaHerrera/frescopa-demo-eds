# Gobierno y accesos

App de da.live para definir **quién puede hacer qué y dónde** en el sitio y aplicarlo en la plataforma.

- **Abrir:** `https://da.live/app/{org}/{site}/tools/governance`. Para una rama: añade `?ref={rama}`.
- **Código:** [`tools/governance.html`](../tools/governance.html), [`tools/governance/`](../tools/governance/). La lógica pura está en [`model.js`](../tools/governance/model.js), sin dependencias.
- **Sidekick:** botón **Accesos**, que abre la app.

## Modelo

| Rol | DA (por ruta) | EDS (todo el sitio) | Además |
|---|---|---|---|
| Admin plataforma | Escribe todo el sitio, `CONFIG` y `/governance` | `admin` | Gestiona el modelo, aprueba y aplica |
| Publicador / aprobador | Escribe en sus rutas, lee el resto | `publish` | Preaprueba solicitudes |
| Editor por idioma | Escribe en sus rutas (p. ej. `/es`), lee el resto | `author` | — |
| Lector / agencia | Lee sus rutas; opcionalmente escribe en una carpeta | `author` solo si escribe en alguna ruta | — |

Para cada ruta gana la regla **más específica**. En empate gana la de mayor nivel: editar está por encima de leer.

### Qué aplica la plataforma y qué aplica la app

| Acción | Quién lo bloquea |
|---|---|
| Leer y editar (crear, mover, borrar) | **DA**, por ruta. Hoja `permissions` de la config de la org |
| Config y apps | **DA** (`CONFIG`) y la **Admin API** (rol `admin`) |
| Preview y publicar | **EDS**, pero **para todo el sitio**: la plataforma no lo limita por ruta |
| Preview y publicar *solo en tus rutas* | **Solo el modelo**. La app lo muestra; la plataforma permitiría el resto |
| Aprobar solicitudes | La app |

La matriz y el simulador marcan esa diferencia. **Ámbar** quiere decir que la plataforma lo permite pero el modelo no. **Azul discontinuo** quiere decir que el modelo lo permite pero aún no se ha aplicado.

## Dónde se guarda

| Qué | Dónde | Visible para |
|---|---|---|
| Usuarios, roles y rutas | `/governance/users.json` (hoja de DA, sin publicar) | Lectura para todos; escritura solo admins |
| Auditoría | `/governance/audit.json` | Igual |
| Solicitudes | `/governance/requests/req-*.json`, una por solicitud | Cualquier usuario del modelo puede crear la suya |
| Permisos DA | `admin.da.live/config/{org}/`, hoja `permissions` | Solo se tocan las filas con `comments` = `gov:{site}`; el resto se conserva |
| Roles EDS | `admin.hlx.page/config/{org}/sites/{site}/access.json` → `admin.role` | Se conservan los emails que no están en el modelo |

Nada de esto está en Git. Los emails nunca se escriben en el código.

## Salvaguardas

- **Admin protegido.** Es quien inicializa el modelo. No se puede degradar ni dar de baja. Conserva siempre `/+**` (toda la org), `CONFIG` write y el rol `admin`.
- **Nadie puede cambiar su propio rol.**
- **Las bajas no borran usuarios:** dejan el registro con estado `baja` y les quitan todas las reglas y roles.
- **Primero el diff y luego confirmar.** Antes de escribir se relee el modelo. Si alguien lo cambió mientras tanto, se cancela.
- **No se escribe nada en la plataforma sin haber leído antes la config de la org.**
- **Si el navegador no puede escribir los roles EDS** (por CORS o permisos), la app muestra el JSON y el `curl` para aplicarlos a mano.

> **Ojo al crear la hoja `permissions` por primera vez:** desde ese momento DA deniega el acceso a cualquiera que no esté en una regla, **en todos los sitios de la org**. La app lo avisa antes de aplicar.

## Flujos

1. **Cambio directo (admin).** Usuarios → editar → borrador → *Aplicar*. Se guarda el modelo, se escriben los permisos DA y los roles EDS, y se registra todo en la auditoría.
2. **Solicitud.** Cualquier usuario del modelo pide un rol y unas rutas con un motivo → un publicador la puede preaprobar → un admin pulsa *Aprobar y aplicar*, que la incorpora al borrador, muestra el diff y aplica → la solicitud queda marcada como `aplicada`. También se puede rechazar con un motivo o cancelar.
3. **Ver como.** Un admin puede ver la app como otro usuario (icono del ojo). Es solo una simulación de la vista.

## Prueba con dos cuentas

1. Abre la app con tu cuenta y pulsa *Crear modelo*: quedas como admin protegido.
2. Usuarios → *Añadir usuario*: la cuenta de prueba como **Editor** con escritura en `/es` → *Aplicar*.
3. Con la cuenta de prueba, en da.live: editar algo en `/es` funciona; en `/fr` el documento se abre en solo lectura.
4. Con la cuenta de prueba, en la app: *Solicitar más acceso* → `/fr`. Con tu cuenta: *Aprobar y aplicar*. Comprueba que ahora sí puede editar `/fr`.
5. Revisa la pestaña Auditoría.

## Pendiente o posible ampliación

- Grupos de Admin Console: cambiar el email por `{IMS Org ID}/{Group ID}` en `groups`. El modelo no cambia.
- Caducidad de accesos (campo de fecha y retirada automática).
- Darla de alta en las hojas `library` y `apps` de la config del sitio (como el Panel QA), para que salga en *Apps* y en *Extensions*.
