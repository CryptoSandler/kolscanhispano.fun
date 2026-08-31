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

**Decisión del dueño, aplicada:** el toggle apagado es un opt-in explícito de ese KOL a
publicar su address. El invariante público se reescribe para afirmar **las dos** mitades:

1. ninguna address de un KOL que no optó aparece en ninguna superficie ni payload;
2. una address publicada corresponde a un KOL cuyo opt-in está **persistido** — no basta
   con que el render lo crea.

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
