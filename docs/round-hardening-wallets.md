# Ronda adversarial: hardening de wallets — 2026-09-06

Pedido del dueño, y **sin código**: `CLAUDE.md` exige una ronda antes de un
cambio al modelo o de una decisión grande de producto, y ésta es las dos cosas.
La ronda pide tres cosas explícitamente, y una que sólo produjo acuerdo no pasó.

---

## 1. El caso más fuerte en contra

**El sistema de amenaza no cierra, y las siete capas no cambian eso.**

El pedido nombra envelope encryption, DEK por fila, rotación documentada, escaneo
de importaciones, rate limit, expiración de token, backups cifrados. Todo eso es
razonable. Pero la pregunta que ninguna de las siete responde es **contra quién**.

Enumeremos a los adversarios de verdad:

| Adversario | ¿Lo para el envelope? |
|---|---|
| Alguien que lee la base (dump, backup filtrado, réplica) | **Sí**, si la clave maestra no está ahí |
| Alguien con la app corriendo (RCE, dependencia comprometida) | **No** — el proceso descifra por diseño |
| Vercel, o quien tenga sus env vars | **No** — la clave maestra vive ahí |
| El operador (nosotros) | **No**, y el pedido ya lo dice |
| Un atacante con el token de admin | **No** para lo que el admin ve |

El envelope mueve la aguja **en una fila de cinco**. Y esa fila —dump de la
base sin las env vars— es la que el cifrado actual **ya cubre**: `WALLET_ENC_KEY`
está en Vercel, no en Neon, y `kol_wallet.address_enc` es AES-GCM con AAD ligada
al id de la fila.

Entonces el DEK por fila, ¿qué agrega? Limita el radio de una clave comprometida
a una fila. Pero si la clave maestra se filtra, el atacante deriva todos los
DEKs. **El DEK por fila protege contra la filtración de un DEK, y no hay ningún
escenario realista donde se filtre un DEK y no la maestra**: los DEKs viven
cifrados en la misma tabla que protegen.

Lo que sí compra: rotación sin re-cifrar cada fila (re-cifrás DEKs, no
direcciones). Eso es **operativo**, no de seguridad, y es una razón legítima —
pero es una razón distinta de la que el pedido da.

**El segundo argumento en contra: el costo de oportunidad es real y está medido.**
Las direcciones que este producto guarda son **públicas por naturaleza**. Están
en la cadena. Lo que el cifrado protege no es la dirección: es **el vínculo
entre una dirección y un handle de X**. Ese vínculo tiene valor —desanonimizar a
un KOL— y por eso el cifrado está bien. Pero conviene decir en voz alta que
estamos protegiendo un *join*, no un secreto, porque cambia qué capas sirven:
contra un join, la mitigación más barata es **no guardar el lado que no
necesitás**, y ahí hay una pregunta que ninguna de las siete capas hace.

**El tercero: el punto (5) contradice al producto.** *"Sin ninguna ruta que
devuelva direcciones ni cifradas"* — pero el admin **tiene** que ver
direcciones: aprueba wallets, da de baja las que un KOL anotó sin firmar
(supersede del 2026-09-06), resuelve duplicados. Un admin que no puede ver una
dirección no puede hacer su trabajo. Lo que se puede pedir es que las vea
**truncadas**, **auditadas** y **de a una**, no en listados.

---

## 2. La colisión con el código real

Lo que sobrevive al contacto, y lo que no.

**Ya está hecho, y el pedido lo pide de nuevo:**

- **(2) índice ciego con clave distinta.** Ya es así. `WALLET_HMAC_KEY` y
  `WALLET_ENC_KEY` son dos variables distintas desde el principio;
  `blindIndex()` usa la primera y `encrypt()` la segunda. **No hay nada que
  hacer** salvo un test que falle si alguien las iguala.
- **(4) rate limit.** `rate-limit-wiring.test.ts` ya afirma que **toda** ruta
  pública corre el limitador antes de leer, y tiene una lista que falla si
  aparece una ruta nueva sin bucket. Falta el **bloqueo por IP** (distinto del
  límite por ventana) y falta cubrir `/api/admin/*`, que hoy está fuera de la
  tabla porque no es pública.
- **(3) escaneo de importaciones.** El repositorio ya tiene el patrón exacto:
  `no-money-path.test.ts` falla si una API de transacción se vuelve importable,
  y `pool-safety.test.ts` hace análisis de punto fijo sobre el grafo de
  imports. Copiar esa forma para `crypto.ts` es de una tarde. **Ésta es la capa
  con mejor relación valor/costo de las siete**, y no es la que el pedido pone
  primero.

**Lo que choca:**

- **(1) migración sin downtime.** Re-cifrar `kol_wallet` con envelope significa
  leer, descifrar con la clave vieja, generar DEK, cifrar y escribir, fila por
  fila, mientras la ingesta escribe. El repositorio tiene **una** herramienta
  para esto (`recompute-dirty`) y no aplica. Necesita una columna de versión de
  esquema de cifrado y un lector que entienda las dos — o sea, el código de
  descifrado soporta dos formatos durante la ventana, que es exactamente donde
  se meten los bugs de cripto. Con 3 wallets en producción, **esto es un
  ensayo, no una migración**; hacerlo ahora es barato y por eso mismo es el
  momento, pero el argumento a favor es "cuesta poco hoy", no "urge".
- **(7) backup cifrado.** Neon ya hace point-in-time recovery. Un backup
  nuestro, cifrado con la misma clave maestra, **agrega un lugar más donde está
  todo** — y el ensayo de restore es un rito que hay que correr o el backup es
  una creencia. El pedido dice "misma clave maestra", y ahí hay un problema:
  si la maestra se pierde, se pierden la base **y** el backup. Un backup que
  muere con el mismo secreto que la base no es un backup contra ese modo de
  fallo.
- **(6) lockfile pinneado.** Ya hay `package-lock.json` y CI usa `npm ci`.
  `npm audit` en CI es una línea. Los headers CSP/HSTS **no están verificados**
  y eso sí es un hueco real y barato.
- **(5) expiración del token.** `ADMIN_TOKEN` es una constante en env comparada
  en tiempo constante. Darle expiración significa emitir algo — o sea sesiones,
  o sea una tabla, o sea el mecanismo que el punto (1) del pedido del perfil ya
  introduce con la cookie de 30 días. **Las dos cosas quieren lo mismo y hay
  que construirlas una sola vez.**

**Lo que el repositorio ya sabe y la discusión no:** `SECURITY.md` existe y
`docs/wallet-warnings.md` también. La regla de la casa dice que nada pide plata
sin pre-flight, y `no-money-path.test.ts` la mantiene dormida a propósito. Nada
de esto cambia con el hardening, y conviene no reabrirlo.

---

## 3. Recomendación honesta

**No construyas las siete. Construí tres, y en este orden.**

1. **El escaneo de importaciones de la clave (3).** Es el que más valor da por
   lo que cuesta, el repositorio ya tiene dos ejemplos del patrón, y es el único
   que hace *imposible* una clase de error en vez de improbable.
2. **CSP/HSTS verificados y `npm audit` en CI (6).** Huecos reales, sin diseño
   de por medio.
3. **Rate limit y bloqueo por IP en `/api/admin/*` (4).** La tabla ya existe;
   falta el bucket y la lista que falla cuando aparece una ruta nueva.

**Postergá el envelope (1) hasta que exista la sesión.** No porque esté mal:
porque `(5)` y el perfil del KOL ya piden un mecanismo de credenciales con
expiración, y hacer la migración de cifrado antes de eso significa migrar dos
veces. Con 3 wallets en producción, esperar cuesta casi nada.

**Rechazá "ninguna ruta devuelve direcciones" (5) tal como está escrito.** El
admin las necesita. Contrapropuesta: truncadas por defecto, completas sólo bajo
una acción explícita que deje entrada en `audit_log` con actor y motivo — que es
el patrón que la reasignación de cabales ya usa.

**Rechazá "misma clave maestra" para el backup (7).** Un backup que muere con el
mismo secreto que la base no cubre la pérdida de ese secreto. Si va a haber
backup propio, va con su propia clave, guardada en otro lado, y con el ensayo de
restore escrito como rito.

**Y lo que hay que decir en `SECURITY.md`, sin esconderlo:** el operador con la
clave y la base **puede descifrar todo**. No hay capa acá que lo impida, ninguna
de las siete lo intenta, y un documento que sugiera lo contrario sería peor que
no tenerlo. Lo que este sistema protege es el vínculo dirección↔handle contra
**terceros**: un dump sin env vars, una superficie pública, un backup filtrado.
Contra nosotros, no protege nada — protege que nadie *más* lo vea.
