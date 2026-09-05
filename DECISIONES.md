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

## Agregar una acción firmable son DOS cambios — 2026-09-04

Una acción de `ProofAction` vive en dos lugares y los dos son obligatorios:

1. **`PROOF_ACTIONS` en `src/lib/wallet-proof.ts`**, de donde sale el tipo. Es lo que el
   verificador compara y lo que el mensaje firmado imprime en la línea `Acción:`.
2. **El `CHECK` de `wallet_proof_nonce.action`**, en una migración. Es lo que decide si la fila
   del nonce entra.

**Los dos olvidos fallan distinto, y por eso hace falta el test.** Ampliar sólo el código produjo
`violates check constraint wallet_proof_nonce_action_check` la primera vez que se emitió un nonce
de cabal — un fallo correcto, pero en el momento equivocado: al *usar* la acción y no al agregarla.
Ampliar sólo la migración es peor y es silencioso — la columna aceptaría un valor que nada en el
código puede producir ni comparar, y la deriva se quedaría ahí hasta que alguien leyera el esquema.

**Quien lo recuerda es `wallet-proof-store.test.ts`**, en el bloque *"the action list in the code
and the one in the schema"*: lee el `CHECK` del catálogo (`pg_get_constraintdef` sobre
`pg_constraint`) y lo compara con `PROOF_ACTIONS` **en las dos direcciones**, con un mensaje que
dice hacia qué lado derivó. Contra el catálogo y no contra un literal en el test, porque un literal
sería una tercera copia de la misma lista — exactamente lo que se está tratando de evitar.

Verificado que muerde: agregando una acción sólo en el código, falla con *"in wallet-proof.ts but
not in the CHECK — the migration is missing"*.

## El nonce se quema ANTES de comprobar la regla — 2026-09-04

`src/lib/cabal-actions.ts` corre los mismos cinco pasos en las seis acciones: verificar la
firma, **quemar el nonce**, resolver la wallet a un KOL, comprobar la regla, actuar y anotar.
El segundo paso va antes del cuarto a propósito, y es la decisión de seguridad de toda la capa.

**Si la regla corriera primero, una firma sería una pregunta gratis.** El sujeto está dentro
del texto firmado, pero nada obliga a que la pregunta se haga una sola vez: con la regla
adelante, un `no_encontrado` devolvería el nonce intacto y quien tuviera una firma podría
reintentarla contra sujeto tras sujeto —"¿@beto está en este cabal?", "¿existe MEX?"— hasta
que una entrara. Cada respuesta saldría gratis y el conjunto de respuestas es el padrón.
Quemando primero, **cada pregunta cuesta una firma que una persona tiene que aprobar en su
wallet**, que es el único precio que un atacante no puede bajar.

El costo es que un rechazo legítimo también gasta el nonce: quien se equivoca de tag pide
otro y vuelve a firmar. Un viaje de ida y vuelta contra un padrón enumerable no es un
intercambio parejo.

Lo cubre *"spends the nonce even when the rule refuses"* en `cabal-actions.test.ts`: la misma
prueba, reenviada después de un `not_found`, contesta `bad_proof`.

### Si el proceso cae entre quemar y actuar

El nonce queda gastado y **la acción no ocurrió**. Se pide otro nonce y se firma de nuevo.

Esto no es un efecto secundario: es la razón por la que los pasos 1 a 3 corren **fuera** de la
transacción que hacen los pasos 4 y 5. La quema se compromete en su propia conexión, así que
el rollback de la acción no la devuelve. La invariante que queda es de una sola línea:

> Un nonce que llegó a la puerta está gastado, pase lo que pase después.

La alternativa —quemar dentro de la transacción— haría que un fallo cualquiera devolviera una
firma reutilizable, y devolvería justo la que menos se entiende: la de un proceso que se murió
sin decir por qué. Entre "el usuario firma de nuevo" y "una firma sobrevive a una caída que
nadie diagnosticó", la primera cuesta un viaje.

**Hay además un motivo mecánico que apunta al mismo lado, y se descubrió antes de escribir el
primer test.** `db.ts` corre el pool en `max: 1`, así que una llamada a `query` desde adentro
de `withTransaction` espera por el único cliente que la transacción ya tiene y se cuelga hasta
el timeout de conexión. `consumeNonce` es una de esas llamadas. La primera versión de
`authorise` la hacía adentro y habría colgado cada acción de cabal en producción con la
apariencia de una base lenta.

Lo cubre `cabal-actions.crash.test.ts`, que mockea `appendAudit` para que tire —el pie de
cualquier fallo posterior a la quema: caída, conexión perdida, timeout— y verifica las dos
mitades: no hay cabal, ni membresía, ni entrada de auditoría, **y** el nonce quedó usado y la
misma prueba reenviada contesta `bad_proof`.

## Co-líderes: los nombra el líder, y son dos — 2026-09-05

**Tomada.** `nombrar co-líder` y `revocar co-líder` son acciones firmadas, por la
misma puerta y con la misma auditoría que las otras ocho. **Solo el líder nombra.**
Un co-líder que pudiera nombrar co-líderes vuelve el tope una formalidad —dos se
nombran reemplazos entre ellos indefinidamente— y deja sin respuesta la única
pregunta que importa después: quién delegó esta autoridad.

**El tope de dos cambió una forma, no agregó una columna.** `migrations/016` tenía
un solo `co_leader_kol_id`, porque §4 solo necesitaba alguien a quien transferir.
Dos no entran en una columna, y una segunda columna es la opción que parece más
barata y no lo es: cada consulta aprende a decir `co_leader_kol_id = $1 OR
co_leader_2_kol_id = $1`, y el día que el tope sea tres, todas están mal de una
forma que igual corre.

`migrations/020` las mueve a `cabal_co_leader (cabal_id, kol_id, slot)`, y **el
`slot` es lo que hace del tope una restricción en vez de una cuenta**:
`CHECK (slot IN (1,2))` con `UNIQUE (cabal_id, slot)`. Un tercer nombramiento no
tiene dónde ir y lo dice la base. Contar filas en el handler y negar en dos es un
read-then-write: dos nombramientos que llegan juntos leen uno los dos. Es el mismo
razonamiento de `cabal_tag_held` y de `wallet_proof_nonce` — la carrera la decide
un índice o no la decide nadie.

Revocar libera el slot y el siguiente nombramiento lo reusa. Un handler que solo
contara hacia arriba negaría después de una revocación y el tope habría pasado a
ser uno en silencio; hay un test para eso.

### El cabal huérfano lo resuelve el admin, y nada más — 2026-09-05

**Cerrado.** Un primer borrador de esta decisión se apoyaba en una disolución por
inactividad que **no existe**: `dissolved_at` se lee en tres lugares y no lo
escribe ningún camino de código —ni cron, ni handler, ni admin; solo los tests— y
en este producto "inactividad" significa lo contrario (`docs/spec-v1.md` §72:
*"Inactive approved KOLs stay in the list at zero"*).

La decisión final no la construye. **No hay timer y no hay auto-promoción.** Un
líder que no puede firmar y sin co-líder deja un cabal que solo mueve la
reasignación por admin del §4, desde `/admin`, con entrada en `audit_log`.

Es una respuesta coherente, pero trae una obligación: **un estado que solo se
resuelve a mano y que nada muestra, se resuelve cuando alguien se queja.** Así que
`/admin` lista los huérfanos (`src/lib/orphan-cabals.ts` detrás de
`GET /api/admin/cabal`) y dice **por cuál de las tres razones** lo es, porque lo
que el admin debería hacer cambia:

- `sin líder` — `leader_kol_id IS NULL`.
- `líder sin wallet activa` — todas retiradas. Es el caso del que hablaba §4: no
  hay firma posible, así que ninguna acción suya pasa la puerta.
- `líder no aprobado` — suspendido o vuelto a pendiente. `authorise` exige
  `kol.status = 'approved'`, así que está igual de trabado, pero el arreglo
  probablemente sea un estado y no un líder nuevo.

Al lado va la cantidad de miembros: es lo que se pierde si queda trabado. Un cabal
disuelto no es huérfano — está terminado, y su sigla corre los treinta días.

**La lista no tiene botón.** Reasignar no está construido, y `docs/padron.md` §4
sigue valiendo para todo control; un botón que no hace nada es el último Don't de
`DESIGN.md`. Lo que cambió es que el estado se ve, en vez de haber que buscarlo.

## La cola de solicitudes la leen líder y co-líderes, nunca es pública — 2026-09-05

**Tomada.** `ver solicitudes` devuelve la cola a quien lidera o co-lidera ese
cabal. `ver mi solicitud` le devuelve al solicitante el estado del **suyo** y nada
más: ni la cola, ni su posición en ella, porque una posición es un hecho sobre las
otras personas de la fila.

Nunca pública, y esa es la mitad irreversible: mostrar quién pidió entrar publica
un rechazo, y a alguien rechazado no se lo puede des-publicar.

**Las dos lecturas se firman**, como toda escritura. Eso es el precio de *sin
sesión de KOL* (§4) mostrándose, no una elección de esta pantalla: nada recuerda
entre dos requests que una wallet lidera algo, así que "mostrame mi cola" tiene que
probarlo igual que "aceptá a esta persona". Cuesta una firma por carga del panel.

Tres consecuencias que quedan escritas porque no son obvias:

1. **El sujeto se compara, no se busca.** Un líder que nombra la sigla de otro
   cabal recibe `not_leader`, no la cola del suyo: la sigla es lo que firmó.
2. **La lectura del líder se audita; la del solicitante no.** Leer quién quiere
   entrar a un grupo es un acceso que la cuenta debería poder mostrar después;
   "@ana preguntó si @ana fue aceptada" es ruido que entierra las entradas que
   importan.
3. **La entrada audita la cantidad, nunca los handles.** Listarlos volvería a
   publicar dentro de `audit_log` justamente lo que la lectura existe para
   mantener angosto. Hay un test que busca el handle en el `after::text`.


## La reasignación es nominación + reclamo firmado — 2026-09-05

**Tomada, y borra una escritura sin firma en vez de agregar una.** Hasta hoy el
plan era que el admin entregara el cabal huérfano directamente: era la única
mutación de cabal que **nadie firmaba** —el líder saliente no puede, y al
entrante no se le preguntaba— y la historia que habilitaba era "el operador movió
un grupo a un amigo", indistinguible de una reparación porque cada fila de la
auditoría sería genuina.

Ahora son **dos actos de dos personas**, y el segundo se firma:

1. **El admin nomina.** Huérfano obligatorio (mismo `ORPHAN_PREDICATE` que usa la
   pantalla), motivo obligatorio, confirmación explícita. **No mueve nada**: ni
   líder, ni membresía, ni aviso público. El cabal sigue huérfano y sigue en la
   lista, porque hasta que alguien firme no pasó nada. Una nominación sin
   reclamar deja el mundo tal como lo encontró, que es la dirección segura.
2. **El nominado reclama** con `reclamar cabal`, la undécima acción firmada,
   contra la misma puerta que las otras diez. La firma del beneficiario es lo que
   mueve el grupo, y la entrada de auditoría la lleva al lado.

**No cierra el agujero de la ronda §0** —nada en el producto pone
`kol_wallet.status = 'withdrawn'`, así que un operador puede fabricar un
huérfano— pero **fabricarlo ya no alcanza**: además necesita a un KOL dispuesto a
firmar el resultado, en público, contra un nonce.

**N = 7 días.** Una nominación es una ventana de coordinación humana: hay que
avisarle a alguien por fuera, que abra la wallet y firme. Un día no le alcanza a
quien está de viaje; un mes deja un derecho vivo sobre un grupo mucho después de
que todos se olvidaron de la conversación. Siete cubren una semana afuera y vencen
mientras el motivo todavía está fresco para escribirlo de nuevo.

El vencimiento se **compara, nunca se indexa**: `WHERE expires_at > now()` en un
predicado de índice lo rechaza Postgres, y `migrations/016` tiene la versión larga
de por qué ese rechazo es correcto. `status` lleva el hecho, el índice único
parcial cubre `pending`, y tanto nominar como reclamar miran el reloj.

**El reclamo revalida que siga huérfano.** Siete días alcanzan para que el líder
viejo registre otra wallet o aparezca un co-líder. Una reparación aplicada sobre
algo que ya no está roto es una toma.

**El aviso público dice las dos mitades**: *"Reasignado por admin, reclamado por
@x el D"*. Nombrar solo al operador esconde quién se benefició; nombrar solo a
quien reclamó se lee como una transferencia común. La fecha es la del **reclamo**.
El motivo sigue sin publicarse: vive en `cabal_nomination` y en `audit_log`, que
solo lee el operador.

## El operador ya no puede fabricar un huérfano — 2026-09-05

`docs/round-reasignacion.md` §0 encontró el agujero y §3 admitió que no se podía
cerrar desde adentro de la base: **nada en el producto ponía
`kol_wallet.status = 'withdrawn'`** —verificado el 2026-09-05, cada aparición
fuera de los tests era un comentario— así que ese valor lo escribía el operador a
mano en SQL y nadie más.

Eso hacía que `líder sin wallet activa`, la razón de orfandad para la que existe
todo el camino de reasignación, fuera **un estado que el operador podía fabricar**:
retirar la wallet del líder, esperar a que el cabal aparezca en la lista de
huérfanos, nominar. Cada fila de la auditoría resultante sería genuina y la
secuencia indistinguible de una reparación.

**`retirar wallet` es la decimocuarta acción firmada, y la firma tiene que venir
de la wallet que se retira.** No hay sujeto: la wallet que firma es la que se
retira, así que la prueba no se puede apuntar a la de otro ni en principio — no
hay campo al que apuntar. Es la misma forma que las dos acciones de `/registro`.

**No hay ruta de admin que escriba esa columna, y hay un test que falla si
aparece una.** `wallet-actions.test.ts` recorre el código versionado buscando
`SET status = 'withdrawn'` y exige que el único escritor sea
`src/lib/wallet-actions.ts`; otro test exige que ningún archivo bajo
`src/app/api/admin` ni `src/app/admin` mencione la palabra.

Con acceso directo a la base el operador sigue pudiendo — nada acá pretende lo
contrario, igual que `migrations/018` es honesta sobre sus disparadores. Lo que
cambió es que **ya no puede hacerlo a través del producto**, y hacerlo por otro
lado es un acto separado que no deja entrada de auditoría, lo cual es en sí mismo
la señal.

### La última wallet se puede retirar, y es una decisión

Un KOL que retira su única wallet no puede firmar nada más, y cualquier cabal que
lidere queda huérfano. Negarlo evitaría eso — y también significaría que **una
wallet única comprometida no se puede revocar**, que es justamente el caso para el
que existe la acción. Una llave que no se puede revocar es peor que un grupo que
necesita una nominación para repararse, y ese camino está construido y probado.

## Tres guardianes nuevos, y por qué son tests y no convenciones — 2026-09-05

**`pool-safety.test.ts`** — `db.ts` corre el pool en `max: 1`, así que una llamada
al pool desde adentro de `withTransaction` espera por el cliente que la propia
transacción tiene tomado y se cuelga hasta el timeout. No es hipotético: la capa
de cabals se escribió con `authorise` llamando a `consumeNonce` adentro de la
transacción y **todas las acciones se habrían colgado**; se encontró leyendo
`db.ts`, que es exactamente como una regla se aplica una vez y después se olvida.
El test recorre el código versionado, calcula por punto fijo qué funciones llegan
al pool (directo o a través de otras) y marca cualquier llamada adentro de un
`withTransaction`. Verificado que muerde: reintroduciendo el bug original,
`cabal-actions.ts:422 calls consumeNonce() inside withTransaction`.

**`action-contract.test.ts`** — una tabla acción × precondición × refusal para las
catorce acciones. Es prosa que falla: se verifica que cubra **todas** las de
`PROOF_ACTIONS`, que cada refusal que nombra exista en `ACTION_REFUSALS`, y que
ningún refusal del código quede sin documentar. Agregar una acción ya eran dos
cambios; ahora son tres, y el tercero es pensar qué contesta.

**`api/cabal/route.test.ts`** — las cinco formas de arruinar una prueba contestan
**bytes idénticos**, comparados en la respuesta HTTP (status + cuerpo), no en la
librería. Un refusal que filtrara la diferencia por un código de estado o un campo
de más pasaría un test de librería y falla acá.

### Retirar la última wallet: permitido, con aviso antes de firmar — 2026-09-05

**Tomada por el dueño.** Un KOL puede retirar su única wallet activa. Queda sin
poder firmar nada, y cualquier cabal que lidere queda huérfano hasta que un admin
nomine a alguien y esa persona lo reclame.

El motivo de permitirlo: negarlo significaría que **una wallet única comprometida
no se puede revocar**, que es justamente el caso para el que existe la acción. Una
llave que no se puede revocar es peor que un grupo que necesita una nominación
para repararse, y ese camino está construido y probado.

**El aviso en `/mi-cabal` es incondicional, y eso es a propósito.** Si esta es o
no la última wallet del lector es un hecho sobre su KOL, y preguntárselo al
servidor querría decir un endpoint que convierte cualquier dirección en un hecho
sobre una persona — la enumeración que este producto rechaza en todos lados
(`hide_wallets` es el default). Así que la frase es condicional: le cuesta una
línea de texto a quien tiene tres wallets, y le dice lo que necesitaba saber a
quien tiene una.

Son **dos pasos**: el aviso primero, la firma después. Un solo botón pondría un
acto irreversible a un click de alguien que entró a hacer otra cosa.

`quedás` entró a la lista de voseo de `copy.test.ts` el mismo día: el aviso se
dictó con esa forma y se escribió `te quedas`. La lista solo crece con formas que
estuvieron cerca de salir, que es lo que la mantiene honesta.

## Disolver un cabal: solo el líder, y es lo único que escribe `dissolved_at` — 2026-09-05

**Tomada.** `disolver cabal` es la decimoquinta acción firmada. Es del **líder y de
nadie más**: ni co-líder, ni admin, ni temporizador, ni ningún camino automático.

**La columna no la escribía nada.** `migrations/016` agregó `dissolved_at` y tres
caminos la leen —la lista de huérfanos, las puertas de entrar y reclamar, y la
liberación del tag— pero **ningún camino de código la seteaba**. Un cabal no se
podía disolver, `scripts/release-cabal-tags.ts` no tenía nada que liberar, y la
regla de los treinta días que el dueño decidió en `docs/round-cabals.md` §4
describía un estado al que el producto no podía llegar. Esta acción es ese
escritor, y es el único.

**Por qué no un co-líder.** Quien pudiera disolver el grupo podría destruir lo que
le prestaron. Las dos cosas que un co-líder no puede hacer —entregar el cabal y
terminarlo— son la misma regla vista dos veces.

**Por qué no el admin ni un timer.** `docs/round-reasignacion.md` ya discutió el
caso general: el operador no recibe verbos que decidan de quién es qué, y terminar
un grupo es ese verbo en su forma más filosa.

**Disolver no libera la sigla.** La libera `release-cabal-tags.ts` treinta días
después, por el cron que ya corre, porque una sigla se retiene mientras está en uso
y un mes más. Liberarla en el momento de disolver sería entregarle la identidad de
alguien a un desconocido esa misma tarde. Tampoco saca a los miembros: conservan
`cabal_id`, el nombre y la historia quedan, y lo que cambia es que el cabal deja de
contar como vivo — que es lo que todos los lectores de `dissolved_at` ya querían
decir con eso.

El tablero lo dice en público: **"Disuelto el D"**, sin motivo. Terminar un grupo es
asunto de su líder y el producto nunca les pidió una razón.

## El mismatch de hidratación era la misma causa por tercera vez — 2026-09-05

`OnboardingModal` tenía `available = activeChains()` como **valor por defecto de un
prop, dentro de un componente cliente**. En el servidor eso lee
`CHAIN_ROBINHOOD_INGESTION`; en el browser `process.env` está vacío. Un solo valor,
dos síntomas: `indexed` cambiaba y con él `disabled` (`disabled={true}` contra
`disabled={null}` en el diff de React), y la frase que arma `listChains` salía
distinta.

Es la tercera vez: `/registro` lo tuvo, `/admin` lo tuvo, y este es el mismo error
con otra ropa. Así que el arreglo no es pasar el valor en este llamador — **el prop
pasó a ser obligatorio y sin default**. Un cuarto llamador que se olvide ahora no
compila, en vez de fallar en el browser con la cara de una feature apagada.

## Un KOL con PnL sin cotizar rankea por lo que cotiza — 2026-09-05

**Tomada.** La clasificación ordena por `SUM(trade.realized_usd)`. Ordenaba por
`realized_sol` hasta hoy, que suma el monto **nativo** de cada chain — con dos
chains indexadas eso rankea gente por una cantidad sin unidad. El USD es la única
cifra que se puede sumar entre chains, que es también por qué el total único del
molde es fiat.

**Una posición que no cotiza aporta cero al orden.** No es un redondeo, es la
decisión: un KOL rankea por lo que cotiza, y alguien cuya mejor operación no se
puede cotizar queda por debajo de alguien cuya peor operación sí. Queda escrito
acá porque es **visible para quien lo sufre e invisible en el número**: la fila
muestra el total cotizado y nada indica, ahí, que falte algo.

Lo que lo hace decible en vez de silencioso:

- La fila muestra el total entre paréntesis. Si **nada** cotiza muestra `(—)` en
  muted — no `US$0,00`, porque el guion dice "no medimos" y el cero diría
  "medimos nada".
- El **modal** del KOL dice cuál posición quedó afuera y en qué unidad:
  `+0,42 ETH sin cotizar (Q30–32)`. La explicación vive donde hay lugar para
  explicar, no en una fila de lista donde una etiqueta en mayúsculas gritaba más
  que las cifras.
- `chain-pnl.ts` sigue negándose a sumar la mitad cotizada de un grupo: un total
  con un agujero adentro es peor que un `null` visible.

**Lo que sigue abierto:** qué cotiza y qué no en cada chain depende de la ingesta
que todavía no existe (no hay credencial de Alchemy en esta máquina, ver
`docs/round-columnas-chain.md` §0). Hoy todo lo que hay es Solana y todo cotiza,
así que la decisión no cambia ningún orden actual — se toma ahora porque después
de que existan filas mueve gente de lugar en el tablero.
