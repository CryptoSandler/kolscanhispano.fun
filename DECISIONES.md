# Decisiones

Registro de decisiones que no se leen del código. Cada una con su fecha, su razón, y
lo que cuesta si estuvo mal.

---

## 2026-08-28 — La tanda de seguridad va en su propia rama, sobre `estetica-kolscan`

`seguridad-post-auditoria`, con base en `20040c7`, **no** en `main`.

**Por qué sobre `estetica` y no sobre `main`:** tres de los hallazgos —H-1 (el blind index
en la query de KOL-detail), M-2 y M-3 (la ruta de avatar y su `Cache-Control`)— viven en
archivos que **sólo existen en `estetica-kolscan`**. `src/lib/kol.ts` y
`src/app/api/avatar/[kolId]/` no están en `main`. Una rama desde `main` no podría
arreglarlos.

**Por qué rama propia y no commits arriba de `estetica`:** el gate visual del dueño sobre
`estetica` sigue pendiente, y el diff que revisó no debería crecer con veintitantos
cambios de seguridad mientras lo mira. Una tanda de seguridad se revisa como tanda de
seguridad.

**Costo si estuvo mal:** si el dueño quiere los arreglos que también aplican a `main`
—M-1, M-5, M-6, `db.ts:44`, F1 a F7— antes de cerrar el gate estético, hay que
cherry-pickearlos. Es trabajo, pero es trabajo acotado y visible; partir la tanda ahora,
en cambio, duplicaría el esfuerzo para un gate que puede cerrarse pronto.

---

## 2026-08-28 — F8 (CSP con nonces) queda diferido

`next.config.ts:24` sirve `script-src 'self' 'unsafe-inline'` en producción. Reemplazarlo
por nonces por request es un cambio propio, no una línea: toca el middleware, el layout y
cada script inline, y hay que verificarlo contra el streaming de React.

Decisión del dueño, 2026-08-28: **fuera de esta tanda**, anotado acá para que no se
pierda. El propio `next.config.ts` ya documenta el trade-off en el lugar donde vive.

**Costo si estuvo mal:** un XSS que hoy sería contenido por un nonce hoy no lo está. El
resto de la CSP —`object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
`form-action 'self'`— sigue en pie, y la auditoría no encontró ninguna primitiva de
inyección en la UI (cero `dangerouslySetInnerHTML`, cero `innerHTML`, cero `eval`).


---

## 2026-08-28 — `key_version` se elimina; la versión vive en el primer byte del blob

Migración `010_drop_key_version.sql`: `kol_wallet.key_version` y `raw_tx.key_version`
dejan de existir.

**Qué eran.** `SMALLINT NOT NULL DEFAULT 1` en las dos tablas, y ninguna sentencia del
repositorio nombraba la columna: ni `wallets.ts`, ni `raw-tx.ts`, ni el parser, ni los
serializadores. Cada fila decía 1 porque el default decía 1. La primera rotación a una
clave v2 habría dejado `key_version = 1` en todas las filas v2 — es decir, la columna se
volvía incorrecta justo en el momento en que debía servir para algo.

**Por qué borrar y no escribir.** La versión ya está guardada, una vez, en el lugar que
tiene que ser correcto: `crypto.ts` la escribe como byte 0 de cada blob y la mete en los
datos autenticados del AEAD, así que un byte de versión alterado falla la autenticación en
lugar de fallar sólo una búsqueda. La columna era una segunda copia, no autenticada, de un
hecho autenticado — y la copia no autenticada era la consultable. Escribirla habría dejado
dos fuentes de verdad para el mismo dato, con la peor de las dos como la fácil de leer.

**Lo que la columna prometía sigue disponible, en SQL y sin desencriptar nada.** La
pregunta de una rotación es "cuántas filas siguen en v1", y `get_byte()` la contesta contra
el ciphertext. Verificado en la rama de tests, 2026-08-28:

    SELECT get_byte(payload_enc, 0) AS version, count(*) FROM raw_tx GROUP BY 1;
    SELECT get_byte(address_enc, 0) AS version, count(*) FROM kol_wallet GROUP BY 1;

**Costo si estuvo mal.** Dos cosas, y ninguna es cara. Si alguna vez hace falta esa cuenta
*indexada* —una rotación sobre millones de filas donde el seq scan de `get_byte` sea
demasiado lento— hay que crear un índice sobre la expresión, no volver a agregar la
columna: `CREATE INDEX ... ON raw_tx ((get_byte(payload_enc, 0)))`. Y si aun así se decide
volver atrás, recuperar la columna es un `ALTER TABLE ADD COLUMN` más un `UPDATE ... SET
key_version = get_byte(payload_enc, 0)`: un solo `UPDATE`, derivado del blob, sin
desencriptar y sin pérdida de información — porque el dato nunca estuvo en la columna.

`docs/spec-v1.md` §8.1 dice "`key_version` is stored per row"; queda anotado ahí que esta
decisión lo reemplaza.

---

## 2026-08-28 — `sslmode` ausente se corrige; `sslmode` equivocado se rechaza

F1 de la auditoría pedía un guard que exigiera `sslmode=verify-full`. Se implementó
primero como un `throw` para cualquier valor que no fuera ése, incluido **ausente**.

`resolveConnectionString` corre en *module load*, así que ese `throw` convierte un
parámetro faltante en una caída de arranque: el primer request después del deploy no
sirve, tira. Y **no se puede saber de antemano si eso iba a pasar**: `vercel env pull`
devuelve los valores sensibles de este proyecto **vacíos** —medido el 2026-08-28 sobre
`production` y `preview`—, así que la grafía real de `DATABASE_URL` en producción no es
legible desde una máquina de desarrollo.

Mergear un `throw` sobre un valor que nadie puede inspeccionar es mergear una caída que
nadie puede descartar.

**Decisión:** el guard *aplica* en vez de *rechazar*.

- `sslmode` **ausente** → se agrega `verify-full` y se devuelve la cadena corregida. Es
  una omisión, no una elección, y el fin es el mismo: la conexión queda verificada.
- `sslmode` **presente y distinto** (`require`, `disable`, …) → sigue tirando. Alguien lo
  escribió a propósito, y pisar una decisión deliberada en silencio esconde la decisión en
  lugar de corregir un olvido.

**Costo si estuvo mal:** una cadena sin `sslmode` que apuntara a un host que no soporta
TLS ahora falla al conectar en vez de fallar al arrancar — más tarde y con un mensaje de
`pg`, no nuestro. A cambio, ningún deploy depende de un valor que nadie puede leer.

---

## 2026-08-31 — El invariante público pasa de "cero addresses" a "solo quien optó"

**No es una flexibilización: el test era más estricto que la norma.** Con los documentos
abiertos:

- `SECURITY.md`: *"**Most** listed KOLs choose `hide_wallets` (the default). **For them**,
  publishing the address would be a deanonymisation they did not consent to."* — el "for
  them" acota la promesa a quienes ocultan.
- `SECURITY.md`, tabla de capas: *"**Serializer-level omission** for **hidden** KOLs (§7)"*.
- `docs/spec-v1.md:481`: *"`hide_wallets` defaults to `true`. A hidden KOL's wallets are
  indexed identically; **only publication**…"*, y `:495`: *"*Wallets ocultas* means we do
  not publish the address."*

`serialize.ts` omitía la address **siempre**, y el test afirmaba cero addresses en toda
superficie. Eso fue correcto hasta hoy sólo porque `hide_wallets` es `true` por defecto y
ningún KOL había optado nunca por lo contrario. La norma nunca prometió cero: prometió
cero **para quien oculta**.

**Decisión del dueño, aplicada — y es por wallet, no por KOL.** El switch vive en cada
fila de "Wallets conectadas" (`Pública / Privada`, default **Privada**) y se persiste en
`kol_wallet.is_public`, nunca como un flag global del KOL. Un KOL puede publicar una
wallet y guardarse otra, que es lo que realmente hace alguien que separa su operación.

Consecuencia sobre `kol.hide_wallets`: deja de gobernar la publicación. Todo lo que se
publica —la address, y también la **firma** de un trade, que en un explorer revela a su
firmante— pasa a seguir la wallet de ese trade (`trade.wallet_id`), no un flag del KOL.
La columna queda sin lectores; se cae en una migración aparte cuando el admin deje de
escribirla, y hasta entonces está anotada como tal para que no repita la historia de
`key_version`.

El invariante público se reescribe para afirmar **las dos** mitades:

1. ninguna address de una wallet con `is_public = false` aparece en ningún HTML servido
   ni payload — verificado hasheando por blind index contra `address_hmac`, no a ojo;
2. una address publicada corresponde a una wallet cuyo `is_public` está **persistido** —
   no basta con que el render lo crea;
3. el detalle del KOL muestra "N wallets privadas" y esa **N coincide con la base**: un
   conteo que se despega es un bug que ninguna de las dos primeras mitades ve.

El leaderboard **no se parte**: el PnL del ranking suma todas las wallets del KOL,
públicas y privadas. El desglose por wallet existe sólo en el detalle y sólo para las
públicas — si el ranking dependiera de cuáles son públicas, el opt-in dejaría de ser una
decisión sobre privacidad y pasaría a ser una sobre el puesto.

La segunda mitad es la que importa: sin ella, un bug que publique todo pasaría el test
mientras exista un solo KOL que optó.

**Costo si estuvo mal:** una address publicada no se puede despublicar — queda en cachés,
en capturas y en la memoria de quien la vio. Por eso el default se queda en ocultar, el
opt-in es una acción explícita del propio KOL sobre su propia sesión, y el admin no puede
activarlo por él.

---

## 2026-08-31 — Un KOL sin verificar no aparece en el leaderboard

Recomendación aplicada. El handle no está verificado hasta el tweet con código (spec §6),
así que el KOL entra como **pendiente** y no aparece en ninguna superficie pública hasta
la aprobación en admin.

La alternativa —mostrarlo con un badge "sin verificar"— regala lo único que el registro
protege: cualquiera puede escribir el `@` de otro y aparecer junto a su nombre en un
ranking de trading. Un badge no arregla eso; sólo reparte la culpa.

**Costo si estuvo mal:** fricción en el alta. Alguien que conecta, firma y no ve nada
puede pensar que falló. Se compensa con lo que dice el modal al cerrar, no aflojando el
gate. **Queda como pregunta abierta del dueño** si prefiere el badge.

---

## 2026-09-01 — `chain` entra en las claves antes de que exista una fila que no sea de Solana

Migración `011_chain.sql`. `chain TEXT` en `kol_wallet`, `trade`, `raw_tx`, `token`,
`position`, `pnl_position_daily` y `pnl_daily`, y dentro de la clave en las siete.

**Por qué ahora y no cuando haya datos EVM.** `docs/multichain.md` §1 mide tres fallas
que son irrecuperables si la clave llega tarde, y las tres comparten forma: **borran o
funden una fila en silencio, y la evidencia de la pérdida es la fila que no se escribió.**
No hay excepción, no hay log, y el webhook contesta `200`.

- `raw_tx.signature_hmac` era PK sola, y **la misma transacción firmada difundida en dos
  cadenas EVM tiene hash idéntico**. La copia de la segunda cadena caía en
  `ON CONFLICT DO NOTHING`. Igual `trade_unique_idx`.
- `token.mint` era PK sola, y CREATE2 pone **la misma address en varias cadenas EVM** de
  forma rutinaria: dos tokens distintos habrían compartido fila de precio y se habrían
  fundido en una posición.
- `pnl_daily` tenía PK `(kol_id, day)`, y **una cadena no se puede derivar hacia atrás
  desde un agregado**.

**El ranking no cambia: sigue consolidado en USD.** La agregación de `pnl_daily` ahora
agrupa **por cadena**, así que el almacenamiento es por cadena y la consolidación ocurre
al *leer* (`leaderboard.ts` suma sin predicado de cadena). Esa es la única forma de que el
filtro por cadena de §2 siga siendo barato después.

**`address_hmac` deja de ser único global y pasa a `UNIQUE (chain, address_hmac)`.** La
misma address EVM es una wallet legítima y **distinta** en BNB y en Ethereum. Con el
índice viejo, un KOL habría podido registrar su address en la cadena que alcanzara primero
y el resto le habría dado error de clave duplicada sin nada que pudiera hacer al respecto.

**La FK compuesta `trade (wallet_id, chain) → kol_wallet (id, chain)`.** `trade.wallet_id`
ya referenciaba una wallet real, pero nada ataba la cadena del trade a la de la wallet: un
bug del parser, o un ingestor EVM apuntado a la config equivocada, podía archivar un trade
de BNB contra una wallet de Solana y todo aguas abajo lo aceptaba. Es una condición que la
base verifica en cada insert y que la aplicación no puede verificar de forma confiable.

**El `DEFAULT 'solana'` se mantiene, y es una decisión con techo.** Soltarlo sería más
estricto, pero obligaba a reescribir los ~30 `INSERT` del repositorio en el mismo cambio
que reclava siete tablas, así que un error en cualquiera de las dos mitades se descubriría
contra la otra. Hoy no puede causar nada: **no existe ingestor EVM**, así que no hay insert
al que el default pueda contestar mal. Se suelta en la migración que traiga el primer
ingestor EVM, que toca todos los sitios de insert igual.

**Costo si estuvo mal:** ninguna de estas claves se puede corregir una vez que hay filas
reales de dos cadenas, porque lo que habría que recuperar son las filas que nunca se
escribieron. Ese asimetría es la razón de hacerlo antes y no después.

---

## 2026-09-01 — `DECIMALS` pasa de 18 a 27

La regla escrita en `decimal.ts` era *"nueve dígitos de sobra por debajo de la unidad más
chica que existe en cadena"*. Con `DECIMALS = 18` esa regla **era falsa para EVM**: un wei
es 10^-18, o sea exactamente una unidad en el último lugar, el margen era cero, y el
redondeo que el módulo documentaba como *"inalcanzable en la práctica"* pasaba a ser
alcanzable por el monto más chico que una cadena EVM puede expresar.

`27 - 18 = 9` restituye el margen enunciado, exacto.

**No mueve nada en la base:** las 20 columnas `NUMERIC` están declaradas sin precisión ni
escala (verificado contra `information_schema.columns`), y `formatDecimal` corta ceros a la
derecha, así que la cadena escrita para un valor dado es byte por byte la que era a 18.

**Lo que sí movió fueron los tests que fijaban la escala a mano.** Nueve en `prices.test.ts`
(literales `10n ** 18n`, incluido el piso de liquidez `FLOOR`, donde 999 pasaba a superar
el piso y el estado daba `priced` en vez de `unpriced`), dos en `pnl.test.ts` y dos en
`parse-swap.test.ts`. Todos se reescribieron **en función de `DECIMALS`** en vez de con
cadenas literales, porque un literal de 18 dígitos hace que un cambio de escala parezca un
cambio de aritmética. Un comentario en `format.ts` afirmaba "escalado por 10^18" sobre dos
constantes que en realidad son escala-independientes; también se corrigió.

**Costo si estuvo mal:** ninguno en datos. El riesgo era exactamente el que apareció —
aserciones que codificaban la escala— y quedó pinchado por tests que ahora la derivan.

---

## 2026-09-01 — La prueba de wallet se construye; el registro no

`docs/wallet-proof.md` cierra la ronda adversarial completa. Lo que quedó:

**Se construye el verificador, no los endpoints.** El formato del mensaje firmado es una
puerta de una sola dirección —una vez que alguien firmó, cambiarlo invalida esa firma— y el
modal depende de él. Los endpoints y las tablas `claim` sí son prematuros: no existe
sesión, no existe nonce endpoint, y el verificador va a estar sin usar hasta que se
construyan. Eso está dicho en el documento en vez de disimulado.

**`@noble/curves` para las dos cadenas, no solo para secp256k1.** En EVM no hay opción:
Node no tiene recuperación de clave pública y la aritmética de curva no se escribe a mano.
En Solana `node:crypto` alcanzaba, pero solo envolviendo una clave cruda de 32 bytes en un
prefijo SPKI DER de 12 bytes — una constante mágica entre una firma y su aceptación. Como
la dependencia se toma igual, una biblioteca y un modelo mental le ganan a una biblioteca
más un encabezado DER armado a mano. `npm audit`: 0 vulnerabilidades.

La afirmación contraria que el repo ya tenía escrita —`no-money-path.test.ts` decía que
SIWS *"is an ed25519 check `node:crypto` already does"*— **se corrigió en el lugar**, no se
dejó pudrir. Es exactamente el error que fue `key_version`: una afirmación escrita que
nadie volvió a leer.

**El nonce lo emite el servidor y se quema en la misma sentencia que lo reclama.** La
implementación de referencia (`nftraffle`) documenta su propio techo: nonce elegido por el
cliente, así que un par mensaje-firma capturado se puede reusar dentro de la ventana. Acá
no. Un `SELECT` seguido de un `UPDATE` está a dos requests concurrentes de aceptar un nonce
dos veces; es un solo `UPDATE ... WHERE used_at IS NULL RETURNING`, y hay un test que corre
ocho reclamos concurrentes y exige que pase exactamente uno.

**Pregunta abierta, del dueño:** si un KOL puede registrar una wallet EVM **antes** de que
esa cadena esté activada. No bloquea nada —`chain.ts` ya nombra las cadenas y SIWE se puede
agregar o retener sin tocar SIWS— pero cambia qué ofrece el modal.

**Costo si estuvo mal:** el verificador queda sin usar hasta que existan los endpoints. Es
código muerto acotado y probado, no una dependencia que haya que desandar.

---

## 2026-09-01 — `/preview/onboarding` es una vista previa, y se borra

La pantalla `¡Casi listo!` necesita una página para poder mirarse, y el registro no existe.
Un `/registro` que renderizara wallets inventadas sería una página que dice ser un flujo que
no es, así que la ruta dice lo que es.

**Cerrada en producción por `VERCEL_ENV`, no por `NODE_ENV`:** Vercel construye un
deployment de Preview con `NODE_ENV=production`, así que un guard por `NODE_ENV` habría
cerrado justamente el deployment para el que la página existe. Contesta `notFound()`, no un
redirect, para que el path sea indistinguible de uno que nunca se ruteó.

**Se borra en la tanda que construya `/registro` de verdad.** Anotado acá y no recordado,
para que no se convierta en una segunda entrada permanente.

---

## 2026-09-01 — Cómo se verificó la migración 011/012/013 en producción

Dos pruebas independientes, porque *"la DDL corrió"* no es *"la restricción muerde"*.

**Espejo.** El esquema de producción, objeto por objeto —constraints, índices y las columnas
`chain` e `is_public`— contra la base de la rama sobre la que corrieron los 977 tests, que a
su vez se cortó de producción **antes** de las migraciones. 87 objetos contra 90, idénticos
salvo tres: `test_database_marker` y sus dos índices. Esa diferencia es la correcta y es una
segunda confirmación por sí sola — producción no lleva el centinela, así que ninguna corrida
de la suite puede truncarla.

**Comportamiento, dentro de una transacción que siempre hace ROLLBACK.** Cada clave nueva se
ejercita con una escritura real, y cada rechazo se verifica **por SQLSTATE**, no por "algo
tiró": si el `INSERT` de prueba hubiera dejado `side` en NULL, la violación de not-null
habría pasado como violación de FK y el caso quedaba verde por la razón equivocada. Eso pasó
en el primer intento y se corrigió antes de correrlo.

    PASS  una address es dos wallets distintas en dos chains
    PASS  la misma address dos veces en UNA chain sigue rechazada (23505)
    PASS  un trade cuya chain no coincide con su wallet lo rechaza la FK (23503)
    PASS  el par wallet/chain que sí coincide se acepta
    PASS  un hash de firma sobrevive en dos chains
    PASS  dos chains conservan dos filas en un día en pnl_daily
    PASS  kol_wallet.is_public arranca en FALSE
    PASS  el segundo reclamo sobre un nonce no obtiene nada
    PASS  el rollback no dejó nada atrás

El cuarto caso existe para que el tercero no pueda pasar por "todo insert falla".

**Orden de la ventana.** Se migró **antes** de desplegar, no después. El código nuevo contra
el esquema viejo tira *cada página* (el feed joinea `kol_wallet`); el esquema nuevo contra el
código viejo solo rompe escrituras —el webhook y los crons— que reintentan. La ventana fue el
tiempo de un deploy.

**Los scripts de verificación no se commitearon.** Escriben en producción, aunque sea dentro
de un rollback, y una herramienta así en el repositorio es una que alguien usa mal más
adelante. El método está acá; reproducirlo son treinta líneas.

## 2026-09-02 — El selector de wallet es de Solana; el EVM entra con la ingesta, por EIP-6963

`/registro` descubre wallets por el handshake de Wallet Standard y muestra las que declaran
cadena Solana, `standard:connect` y `solana:signMessage`. No nombra ninguna wallet: la lista
es abierta por construcción.

**Rabby no aparece, y no es porque una lista la excluya.** Verificado en `rabby.io` el
2026-09-02: publica 63 cadenas, todas EVM, y se titula *"Your Go-to Wallet for Ethereum and
EVM"*. No registra cadena Solana, así que ningún selector de Solana puede mostrarla. Es una
ausencia que decide la wallet, no nosotros.

**Cuando se abra la ingesta de una chain EVM, `/registro` suma conexión EVM.** No antes:
`activeChains()` ya sostiene que una wallet en una cadena que nada indexa es un control que
no funciona, y una wallet EVM conectada hoy produciría una fila que ninguna ingesta lee.
Ese día Rabby aparece sola, otra vez sin que nada la nombre.

**La forma está decidida y es la de `nftraffle`**, que ya la tiene en producción:

- **descubrimiento por EIP-6963** — escuchar `eip6963:announceProvider` **antes** de
  despachar `eip6963:requestProvider`, que es lo que evita perderse la wallet que se anunció
  durante el render que montó el listener;
- **prueba por `personal_sign`**, sobre el mismo texto que `wallet-proof.ts` ya construye,
  con la cadena dentro del payload firmado y no tomada de la red en la que esté la wallet;
- **la lógica pura separada del `window`**: en `nftraffle` son `lib/wallet/evm-discovery.ts`
  y `lib/wallet/evm-binding.ts`, testeados en Node, contra un único archivo que toca el
  navegador. Acá vale lo mismo, y `wallet-standard.ts` ya está escrito así.

**Lo que no se copia, y es la mitad del motivo de escribir esto.** `nftraffle` le pide a la
wallet tres cosas, y la tercera es pagar. Acá esa tercera está prohibida: la prohíbe
`no-money-path.test.ts`, que es lo que hace de "esta página no puede mover fondos" una
propiedad del repositorio y no una promesa en un comentario. Del enfoque de `nftraffle` se
toman el descubrimiento y la firma; el envío no cruza.

**El selector se abre con dos o más wallets; con una sola, conecta directo.** Un selector de
una fila hace una pregunta con una única respuesta —el último Don't de `DESIGN.md`— y le
cobra un click a cada lector para que la minoría con dos pueda elegir. Lo que decide es
cuántas se registraron, no nada que el código sepa de ellas.
