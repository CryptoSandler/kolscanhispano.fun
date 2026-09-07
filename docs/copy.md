# Copy: Spanish sentences, English terms

The site is in Spanish. Its **vocabulary is not**, and pretending otherwise produced copy that
no reader of this product would write: `cartera` for a wallet, `operar` for a trade, `en vivo`
for a live feed. The Spanish-speaking crypto community says wallet, trade, live. Translating a
term the audience already uses in English does not make the site more Spanish; it makes it read
like a translation.

Owner's decision, 2026-09-03. This file is the list the guard reads.

## The two rules

1. **Sentences, titles and labels are Spanish.** `Wallets ocultas`,
   `Nadie cerró operaciones hoy todavía`, `Entrar al padrón`. Grammar, connectives and anything
   a reader parses as a phrase are Spanish, always.
2. **Terms of art stay in English**, from the list below, and are not conjugated into Spanish.
   A term is a noun the community uses as a name for the thing. It is not a licence to write an
   English sentence.

The two combine the way they do in the wild: *"el swap no llegó"*, *"tus wallets quedan
privadas"*, *"PnL del período"*.

## The list

`Trade` · `Cabals` · `Wallet` / `Wallets` · `PnL` · `Live` · `swap` · `token` · `holder` ·
`sniper` · `KOL` / `KOLs` · `DeFi` · `leaderboard` · `Connect Wallet` · `KOL Leaderboard`

The last two were added on 2026-09-05 by the owner and are **titles of things on
screen**, not common nouns: the header's action and the home's heading. They are
the two places this site says something in English where a Spanish phrase would
have done — `Entrar al padrón` and `Clasificación de KOLs` are what they replaced,
and both are recorded above and in `DESIGN.md`.

Capitalisation follows use: `Trade` and `Cabals` are the names of pages and take a capital;
`swap`, `token`, `holder` and `sniper` are common nouns and do not, unless they open a
sentence. `PnL` and `DeFi` keep their own casing everywhere — they are not acronyms this
project gets to restyle.

**Plurals take the Spanish `-s`, never `-es`**: `wallets`, `tokens`, `KOLs`, `snipers`. Gender
is feminine for `wallet` (`la wallet`, `wallets ocultas`) and masculine for `swap`, `token`,
`holder` and `sniper`, which is what the community writes.

## SUPERSEDED 2026-09-05: the screen is called `KOL Leaderboard`

The owner decided the home's title is **`KOL Leaderboard`**, the mould's own,
and that the anglicism is allowed there. The section below is what stood until
then and is kept because most of it still governs.

**What changed:** the `<h1>` on the home. Nothing else.

**What did not:**

- **`ranking` is still banned.** It was never the alternative — the problem it
  caused was three names for one screen, and `ranking` was the third.
- **`el leaderboard` / `leaderboard de X` are still banned.** The term may name
  *this screen* as a proper title and may still be a common noun for the kind of
  thing. It may not become a Spanish noun phrase.
- **The route, the identifiers and the prose are unchanged.** `/leaderboard`
  still redirects to `/`, `Clasificación` stays in `WINDOW_MEANINGS`, in the
  documents and in sentences about the list.
- `copy.test.ts` needed no change: its patterns match an article before the word
  or the word followed by `de`, and a bare title is neither. That it still passes
  is the evidence the ban it enforces was narrower than the prose suggested.

The one thing lost is the argument below about a screen having one name. It has
one name; the name is now in English.

## What stood until 2026-09-05: `leaderboard` is on the list and is still not the name of the screen

The one term with a condition, and the condition is older than this file. `DESIGN.md`: *"The
ranked list is called `Clasificación`, everywhere a reader can see."* It had three names at once
— the nav said `Clasificación`, an onboarding CTA said `leaderboard` and five sentences said
*"el ranking"* — which reads as three screens rather than one.

So: `leaderboard` may appear as a **common noun for the kind of thing** (*"un leaderboard de
PnL realizado"*). It may not appear as **this screen's name**, and `ranking` may not appear at
all — it is neither Spanish nor the community's English. `copy.test.ts` looks for the article
in front of the word, which is what tells a name from a term.

## What the guard checks, and what it cannot

`copy.test.ts` enforces three things: no voseo anywhere a reader can see (the Rioplatense scan,
unchanged — neutral Spanish is a separate decision from this one), no `ranking`/`leaderboard`
standing in for `Clasificación`, and that **every term in the list above is spelled in the UI
the way this file spells it** — so `Pnl`, `Defi`, `wallett` or `cabales` fail.

It does **not** check that an English word is on the list before it ships. That check cannot be
written without a Spanish dictionary, and a list of banned English words is a list that is
always one word out of date. This file is the reference a reviewer reads; the guard is what
stops the list and the screen from drifting apart once a term is on it.


## Nada de códigos internos en superficie pública — 2026-09-05

Ningún texto que vea un lector nombra una referencia que solo existe adentro de
este trabajo: números de pregunta (`Q30–32`), identificadores de tanda, nombres de
archivo, secciones de documentos internos, ids de tickets, nombres de tablas o de
migraciones.

**Salió a la superficie una vez.** El modal del KOL mostró
`+0,42 ETH sin cotizar (Q30–32)`: `Q30–32` son preguntas abiertas del repositorio
`arrival`, que ni siquiera está en esta máquina. Un lector no tiene forma de
resolverlo y nadie afuera de este trabajo tampoco. Quedó como
`+0,42 ETH sin cotizar — el par de este token no tiene precio en dólares todavía`.

**La prueba es simple:** si la frase obliga a abrir un documento que el lector no
tiene, no es copy, es una nota para nosotros. La nota va en el código, donde vive
el resto de las notas — el comentario de `chain-amounts.tsx` sí nombra
`docs/multichain.md` §4, y está bien, porque lo lee quien mantiene esto.

Vale para todas las superficies públicas: filas, modales, estados vacíos, mensajes
de error, `title`, `aria-label` y metadatos.


## `padrón` es término interno — 2026-09-06

Decisión del dueño. `Entra al padrón` salió de toda superficie pública: el único
título de la pantalla de conexión es **`Conecta tu wallet`**, el del modal.

`padrón` sigue siendo la palabra que este equipo usa para el conjunto de KOLs
aprobados —está en comentarios, en documentos y en `/admin`, que es una
pantalla interna— y **no aparece donde la vea un lector**. Los mensajes de error
que la nombraban dicen ahora `ya está registrada` / `ya está registrado`.

No es que la palabra estuviera mal: es que le pedía al lector saber cómo
llamamos nosotros a nuestra lista para entender un mensaje sobre su wallet.

## La línea de privacidad, y la excepción de voseo — 2026-09-06

Texto exacto en `registro-form.tsx` (`PRIVACY_LINE`), y **aparece una sola vez**:
vivía duplicada en el modal y en el formulario, y se veía dos veces seguidas.

> Tus wallets nunca se publican, salvo que elijas mostrarlas; tampoco publicamos
> tus operaciones una por una. Firmas un mensaje, no una transacción.

**El dueño la escribió con `Firmás`**, y va `Firmas`. La regla de arriba prohíbe
el voseo en toda superficie que vea un lector y `copy.test.ts` la controla; el
sitio es para España y Latam. Queda anotado acá porque es una corrección sobre
un texto que el dueño dio como exacto, no una elección de estilo mía.

La cláusula `tampoco publicamos tus operaciones una por una` se sumó con la
eliminación del feed público: antes la frase prometía algo que la página de al
lado contradecía.


## En un modal, una línea de ayuda por control — 2026-09-06

Regla del dueño, y viene de mirar `Casi listo` en el gate: era un muro de texto.
Cada control arrastraba dos o tres frases —que el PnL suma todas las wallets, qué
cadenas se indexan, qué pasa al publicar una dirección— y el resultado era que el
botón primario quedaba abajo de todo, fuera de pantalla a 390.

**Una línea de 13 px por control, y nada más.** Lo que no entra va detrás de un
`?` o al perfil, que es donde alguien lo va a buscar cuando lo necesite.

Lo que quedó, para que se vea el tamaño:

- Visibilidad: *"Privada por defecto. Pública muestra la dirección; una vez
  pública no se puede ocultar."*
- Handle: *"Después publicas un tweet con tu código para verificar."*

**Sin signos de admiración** (`Casi listo`, no `¡Casi listo!`) y **sin repetir el
rótulo**: decía `TU CUENTA DE X` arriba y `Usuario de X` abajo, dos nombres para
un campo.

La línea de privacidad **no se repite** en este paso: ya se leyó en el anterior.


## `Entrar al ranking`: la excepción del CTA — 2026-09-06

Texto exacto del dueño para el botón primario del modal de conexión. Cae bajo la
prohibición de arriba —`al` + `ranking` nombra la pantalla— y se permite igual,
como ya se permitió `KOL Leaderboard` para el título de la home.

**Está en `copy.test.ts` como una cadena literal permitida**, no como un agujero
en la regla: cualquier otro `el ranking` en cualquier archivo sigue fallando la
suite. Lo que se paga es que la lista vuelve a tener un segundo nombre, en un
botón; lo que la regla evitaba era tener tres a la vez, en la prosa, el título y
el nav, que es lo que efectivamente pasó y por lo que la regla existe.


## El grupo se llama **DAO**, no cabal — 2026-09-07

Decisión del dueño. En **toda superficie pública** el grupo es una **DAO**:
el nav dice `DAOs`, la página es `/daos`, la del líder es `Mi DAO`, y la sigla
en el modal y en la PnL Card se presenta como `DAO: XYZ`.

**El molde dice `Cabals`, y acá se dice distinto a propósito.** Es el único
lugar donde nos apartamos de kolscanbrasil en una etiqueta a sabiendas —
`docs/clone-map.md` lo anota del lado del molde.

**Género femenino: `la DAO`.** "Sigla de la DAO", "sigues en la DAO", "mientras
la DAO exista".

**Adentro sigue diciendo `cabal`, y eso no es una inconsistencia que haya que
arreglar.** Las tablas (`cabal`, `cabal_co_leader`), las columnas (`cabal_id`,
`cabal_tag`), los identificadores y **las acciones firmadas** (`crear cabal`,
`transferir el cabal`) no cambian: renombrarlas costaría una migración y, peor,
cambiar `PROOF_ACTIONS` invalidaría cada firma ya emitida. Un nombre visible no
justifica ninguna de las dos cosas.

La sigla de tres letras no cambia: `EJE`, `LAT`, `IBE` siguen siendo eso.
