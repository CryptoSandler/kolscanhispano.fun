# Clone map: kolscanbrasil.io → kolscanhispano.fun

**Owner's decision, 2026-09-02, supersedes `DESIGN.md` where they collide:** *"quiero
literalmente la misma web pero en español."* kolscanbrasil.io stops being a genre reference
and becomes a 1:1 mould. Every surface, layout, hierarchy, colour, density, component, label
and behaviour is replicated, translated into neutral Spanish.

**Three exceptions, and only three.** Where `DESIGN.md` or the spec said otherwise out of
taste — three tints instead of medals, ISO weeks instead of `7D`, our own empty states — the
mould wins and `DESIGN.md` is rewritten as *"a clone of kolscanbrasil.io, with these
exceptions"*:

- **(a)** No address that is not public, and every avatar through `/api/avatar` — never a
  hotlink.
- **(b)** Nothing that signs a transaction or moves funds (`no-money-path.test.ts`).
- **(c)** No asset and no code of theirs copied byte for byte. Logo, icons, illustrations and
  CSS are rebuilt by hand to look the same; typefaces are matched with the nearest free one.

Reconnaissance with a real browser, 2026-09-02, 1280×900 and 390×844, `pt-BR` locale.
Captures in `~/proyectos/evidencia/kolscanhispano/2026-09-02-clone/ellos/` (35 files) and
`nosotros/`. Read in pairs.

---

## 0. Two things the reconnaissance found before any comparison

**Their own site is inconsistent about language.** The home page ships the window toggle in
**English** — `Daily · Weekly · Monthly` — while `/cabals` ships it in **Portuguese** —
`Diário · Semanal · Mensal`. Both live, same day. The clone takes the Portuguese one
translated (`Diario · Semanal · Mensual`), because a Spanish site with English toggles would
reproduce their mistake rather than their design.

**Two of the four blocks in their KOL modal do not work.** `CALENDÁRIO DE PNL` renders `--`
and a 7×5 grid of empty cells; `DEFI TRADES` renders six skeleton bars. Measured across two
viewports, three window tabs and two separate waits of 12 seconds — always the same. `STATS`
and `CHAIN PNL` populate correctly and change with the window.

That is a defect on the reference, not a design to copy. **The clone builds the block; it does
not reproduce the emptiness.** Ours already renders both with real data, so for these two the
mould is the *layout and the labels*, and the behaviour stays ours.

**And it contradicts `references.md` §6**, which records this modal from owner screenshots on
2026-08-27 as a `PNL EVOLUTION` line chart with point markers. What is live on 2026-09-02 is a
calendar heatmap. Either they changed it or the earlier record was of another state; the clone
target is what is live, and §6 is now marked stale.

---

## 1. Header — every page

| | Ellos | Nosotros | Estado |
|---|---|---|---|
| Mark | 🇧🇷 flag tile + `KOLScan **Brasil**`, "Brasil" in blue | 🇪🇸 tile + `kolscanhispano**.fun**`, `.fun` in cyan | **listo** (2026-09-03). The tile held `kh` for a day: no single flag is honest for a site serving Spain *and* Latin America, and that objection was overruled by the owner rather than answered. It is the one that returns the first time a reader in Bogotá asks whose site this is |
| Subtitle | `Ranking de Traders Brasileiros`, grey, under the mark | `Clasificación de traders hispanos` | **listo** |
| Nav | `● Trade` (green live dot) · `Cabals`, right | `En vivo` · `Clasificación` · `Cabals` · `Operar`, centre | **listo salvo la alineación**: both their pages exist here since 2026-09-02. The green live dot is not copied — green is direction of money in this system |
| Wallet | `🔗 Conectar Wallet`, bordered pill, right | `🔗 Entrar al padrón`, bordered pill, right | **listo** (2026-09-02). Exception (b): it opens `/registro`, never a transaction |
| Header height / rule | ~84px, hairline under | ~84px, hairline under | **listo** (2026-09-02) |

## 2. Home = the ranking

Their home **is** the leaderboard: no hero, no feed, no value props. **Ours too, since
2026-09-03** — the feed moved to `/en-vivo` and `/leaderboard` redirects to `/`.

| | Ellos | Nosotros | Estado |
|---|---|---|---|
| Page title | `KOL Leaderboard`, left, on the controls row | `Clasificación` and its subtitle, left, on the controls row | **listo** (2026-09-02) |
| Controls | `USD·BRL` then `Daily·Weekly·Monthly`, right of the title, two pill groups | `DIARIO·SEMANAL·MENSUAL` and `USD·ARS`, right of the title | **listo** (2026-09-02). `/cabals` carries the window group alone: no figure there is in a fiat the reader chose |
| Currency | `USD · BRL` | `SOL · USD` | **decidido, con ronda escrita**: `docs/round-ars.md`. A display conversion over the stored USD, at one dated public rate, with the source printed. **Which rate stays the owner's open decision** |
| Rows | Cards, gap between them, rounded, no header row | Cards, 6px gap, `radius-md`, no header row | **listo** (2026-09-02) |
| Live feed | none | `En vivo` at `/en-vivo` | **resuelto por el dueño, 2026-09-03**: the home page is the ranking, as on the mould, and the feed keeps its own route rather than being deleted — which is where kolscan.io puts theirs |

## 3. The ranking row

| | Ellos | Nosotros | Estado |
|---|---|---|---|
| Podium 1–3 | 🏆 🥈 🥉 emoji + solid left bar + gradient fading right | 🏆 🥈 🥉 + left bar + gradient | **listo** (2026-09-02). DESIGN.md's *"three tints, not three metals"* was rewritten rather than worked around |
| Rank 4+ | plain numeral, grey | plain numeral, `ink-subtle` | **listo** (2026-09-02) |
| Avatar | 36px circle, photo, hotlinked from `pbs.twimg.com` | 36px circle via `/api/avatar/<kol_id>` | **listo** — exception (a) keeps our proxy |
| Identity | name bold, then cabal chip, then `𝕏`, then address chip **or** `Wallets Ocultas` | name, `@handle`, `Wallets ocultas`, chip — one line | **listo** (2026-09-02). The handle is printed where theirs prints a glyph, which is ours to show |
| Cabal chip | solid colour background, dark text, `radius-sm` | solid tint, `canvas` text, `radius-sm` | **listo** (2026-09-02). The contrast table now measures the ink on the tint, not the tint on `surface-2` |
| Address chip | `0x3719` + `EVM` tag, and `CDus2r +2 ⌄` for several | never | **no se copia — excepción (a)** |
| PnL | one column per chain, negative red, positive in the chain's colour | one SOL figure by sign | **adaptar**: we index one chain, so one column. Colour stays by sign |
| Fiat | `(R$79.620,4)` at row end, grey | `(+US$3.100,50)` at row end, grey | **listo** |
| Record | none | none | **listo** (2026-09-02). Off the card; `wins`, `losses` and `winRate` stay in `/api/leaderboard` and in the empty-state rule |

## 4. The ranking at 390 — the defect the audit found

Theirs wraps the row: identity and fiat on line one, figures on line two, **both always
visible**. Ours keeps six fixed columns in a horizontal scroller, so the PnL — the sort key —
is off the right edge.

**Estado: hecho, 2026-09-02.** The ranking is a `<ul>` of grid cards; below 800px the card
wraps — identity and the ranked figure on line one, `Cerradas`, `% ganadas` and the
parenthesised figure on line two — so nothing is behind a horizontal scroll at 390. The
CSS-only attempt that was reverted first is recorded above and in `globals.css`: with
`<colgroup>` and `table-layout: fixed`, `display: none` on cells does not remove columns, so
the header and body desynchronised. Moving to cards (§2) removed the table and dissolved the
problem rather than patching it — the two were one job, and were done as one.

`e2e/viewport.spec.ts` now measures the **PnL cell** at both sizes — inside the viewport,
unscrolled, and not clipped by its own box — because the guard that existed measured the
document and was green over this the whole time.

DESIGN.md was rewritten where it collided: Layout now says the ranking is a card list and
that the no-reflow rule is carried by fixed grid tracks, Responsive carries the 800px change
of shape, and `row-leaderboard` is a card with a border rather than a row with a hairline
bottom.

## 5. The KOL modal

| | Ellos | Nosotros | Estado |
|---|---|---|---|
| Header | 64px avatar, name bold, `𝕏`, cabal chip; `@handle` + total PnL green on line 2; truncated address chip on line 3 | avatar, name, handle, chip, PnL | **listo salvo el orden de líneas.** Address chip **no se copia — excepción (a)** |
| Block 1 | `CALENDÁRIO DE PNL` — a 7×5 calendar heatmap **(broken on their site: `--`, empty cells)** | `Calendario de PnL`, one cell per day of the window | **listo, 2026-09-02.** `src/lib/calendar.ts`. The layout is the mould, the emptiness is not; the line chart and `chart.ts` were deleted with it |
| Windows | `1D · 7D · 30D`, right-aligned **below** the card | `Diario · Semanal · Mensual` inside the card head | **su propia ronda — see §8.** The only item here that changes what a figure means rather than how it is drawn |
| Block 2 | `STATS`: PnL Total, Trades, + one more | `PnL total`, `Operaciones`, `Volumen` | **listo** |
| Block 3 | `CHAIN PNL`: coloured dot + grouped chains (`BSC`, `Base + Ethereum + Robinhood`, `Stable`) | `PnL por cadena`: one line, SOL | **adaptar**: one chain, one line, with their dot |
| Block 4 | `DEFI TRADES`, right column **(broken: skeletons)** | `Operaciones del período`, right column | **listo, 2026-09-02**; behaviour stays ours |
| Layout | two columns below the calendar | two columns below the calendar, one below 640px | **listo, 2026-09-02** |

## 6. `/cabals` — a page we do not have

Their richest surface, and entirely absent here.

- Title `Ranking de Cabals`, subtitle `Grupos de traders competindo por lucro`,
  `← Voltar ao Leaderboard` right.
- Toggles `Diário·Semanal·Mensal` + `USD·BRL`, centred under the title.
- **Podium as three large cards, centre-stage**: #2 left, #1 centre and taller, #3 right. Each
  carries a coloured glow, a medal or gem glyph, a large circular logo with a status dot, the
  name, `(TAG)` in grey, the PnL large in green, and `N membros`.
- `OUTROS CABALS` below: a list with a left accent bar, rank, avatar, name + `(TAG)` + `𝕏`,
  `N membros`, PnL right, and a `⌄` expander.

**Estado: hecha, 2026-09-02.** `src/lib/cabals.ts` ranks the groups out of `pnl_daily` — inner
join on approved members, `count(DISTINCT k.id)` so the day-join cannot inflate a roster — and
`src/app/cabals/` renders the podium and the list. Three things of theirs are **not** copied,
each for a rule this product already had: the logo is a monogram and never a fetched URL
(exception a), there is no `𝕏` per cabal because `cabal` has no handle to link, and the coloured
halo is a shadow, which Colors forbids outside the modal's scrim — the tint arrives as the wash
and bar a ranked card already uses. The status dot is not copied either: it marks something
their product knows and ours does not.

## 7. `/trade` — a page we do not have

An affiliate landing for GMGN.

- Pill `PARCEIRO · GMGN`, green on dark green.
- Display headline `Comece a tradar` / `on-chain`, second line green, condensed wide sans.
- One-line subtitle naming the partner.
- Divider `▣ COMO COMEÇAR ▣`, cyan, letterspaced, hairlines either side.
- Four cards `01–04` with a huge ghosted numeral behind the content and corner tick marks; the
  last one has a green border.
- A second divider `▣ O TERMINAL PARCEIRO ▣`.

**Estado: hecha, 2026-09-02.** The layout, the dividers and the four steps, translated. One
correction to what this section asked for: **the call to action is not a disabled button.** A
disabled control is the single shape DESIGN.md's last Don't names — *"not a disabled tab with a
tooltip; it is absent"* — and this repository already resolved the identical case, the wallet
slot in the header while `/registro` did not exist, as a muted unfocusable label. So the page
reads spec §1.9's affiliate row: a real `rel="sponsored"` link once one exists, and until then a
label saying there is no partner terminal yet. No affiliate link until there is one, which was
the actual requirement.

Their headline's second line is green; ours is cyan. Green is direction of money in this system
and a headline is not a figure.

## 8. Rolling windows — the deepest change, flagged rather than started

`1D · 7D · 30D` are **rolling** windows on the mould: their modal header reads `+R$88.856` on
`1D` and `+R$1.100.948` on `30D`, and both move with the clock.

Ours are **calendar-aligned UTC** and that is not a label: `docs/spec-v1.md` §4.9 fixes it,
`windows.ts` computes it, `pnl_daily` stores one row per KOL per UTC day, and every figure on
every surface is summed from those rows. `Semanal` means the current ISO week — one day long
on a Monday.

Changing to rolling windows changes **what every number on the product means**, not how it is
labelled. It needs its own round: a query that sums the last N×24h rather than the current
calendar bucket, a decision about whether `pnl_daily`'s grain still serves, and a migration if
it does not.

**Estado: decidido por el dueño, no empezado, y confirmado como su propia ronda el 2026-09-02.**
It is the one item in this document that is not a rendering change. The calendar built in §5
spans **the window** for exactly this reason: a grid of five rolling weeks beside a header
summing one calendar day would be two different periods on one card.

## 9. What still needs the three real KOLs

- The calendar heatmap with more than one day of data.
- A `DEFI TRADES` list longer than one row.
- Cabal density on a real roster.

Everything else in this document was decided from the captures.


## Corrección a §8: todas las filas son tarjetas — 2026-09-05

§8 decía que las filas fuera del podio eran transparentes. **No lo son.** Medido
en el DOM de kolscanbrasil a 1440 el 2026-09-05, con `.kol-row` en la mano:

| | fondo | radio | borde izq. | alto | margen inf. |
|---|---|---|---|---|---|
| 1º | `linear-gradient(90deg, rgba(0,155,58,.25), rgba(89,141,176,.15))` | 8px | 4px `rgb(0,155,58)` | 76 | 8 |
| 2º | `linear-gradient(90deg, rgba(254,223,0,.15), …)` | 8px | 4px `rgb(254,223,0)` | 76 | 8 |
| 3º | `linear-gradient(90deg, rgba(0,39,118,.2), …)` | 8px | 4px `rgb(0,39,118)` | 76 | 8 |
| **4 en adelante** | **`rgba(89,141,176,0.15)`** | **8px** | **ninguno** | 76 | 8 |

Padding `16px 20px`, avatar 44×44, ancho de tarjeta 992 empezando en x=224.

**Lo único que distingue al podio es el degradado y la barra de 4px.** El fondo,
el radio, el alto y el margen son iguales en todas.

### Cómo se produjo el error, que importa más que el error

La primera sonda leyó el elemento equivocado: `.kol-row` tiene adentro un
`div.hidden.md:flex.px-5.py-4` que **sí** es transparente y con radio 0, y ese
fue el que se midió. La sonda "subir hasta encontrar un ancestro opaco" tampoco
sirvió — el fondo del podio es `background-image`, no `background-color`, así que
la condición de opacidad lo saltó y trepó hasta el `body`. Es la misma clase de
artefacto que ya está anotada en este documento para el tile y la medalla: **una
sonda que sube por el árbol se detiene en lugares distintos en cada sitio.**

Lo que lo resolvió fue mirar el `className`: `rounded-lg mb-2 kol-row` está en el
elemento correcto y se lee de una.

### La grilla de figuras, medida

Cuatro pistas fijas, alineadas a la derecha, que terminan justo en el borde
interno de la tarjeta:

| slot | x | ancho |
|---|---|---|
| ETH | 676 | 120 |
| BNB | 796 | 130 |
| SOL | 926 | 130 |
| fiat | 1056 | 140 |

**No colapsan.** Una chain sin dato deja su celda vacía y las demás no se mueven,
que es lo que mantiene el paréntesis del total empezando en la misma x en todas
las filas. `e2e/chain-columns.spec.ts` lo mide en un navegador en vez de confiar
en el CSS.

**Y no hay total nativo.** Los montos nativos viven en los slots por chain; el
único número consolidado es el fiat. Nuestra fila tenía además una columna de
total nativo, que en una fila sólo-Solana imprimía `+12.50 SOL` dos veces.


### Las columnas son por unidad, no por chain — 2026-09-05

El molde tiene **tres** columnas de monto: ETH, BNB, SOL. No tiene una por chain.

Importa acá porque este producto indexa —o va a indexar— dos cadenas denominadas
en ETH: **Robinhood Chain (4663) y Ethereum (1)**. Una columna por chain daría dos
columnas `ETH` una al lado de la otra, que no es lo que ellos muestran y no es lo
que un lector espera.

Así que los slots se agrupan por **unidad** y las dos cadenas ETH **se suman en un
solo slot**. Es la única aritmética de este tablero que cruza cadenas, y está
permitida justamente porque no las cruza: son la misma unidad, así que es una
suma y no el error de categoría que cometía el orden nativo viejo
(`SUM(realized_sol)` sumando SOL con ETH, ver `DECISIONES.md` 2026-09-05).

El desglose por **chain** sigue existiendo donde hay lugar para explicarlo: la
sección `CHAIN PNL` del modal lista cadenas, no unidades, así que ahí se ve qué
parte del ETH vino de cada una.


### El wordmark va en blanco: excepción deliberada al azul del molde — 2026-09-05

El molde pone la segunda palabra de su wordmark en su celeste de marca
(`KOLScan **Brasil**`). Acá **`KOLScan Hispano` va entero en blanco `#EDEDED`**, y
es una excepción decidida, no un descuido.

**Por qué.** Sobre el wordmark corre el brillo de banderas de los veintiún países
hispanohablantes, sobre las dos palabras y no sólo sobre la segunda. Un degradado de banderas sobre una base celeste se lee como un
color sucio; sobre blanco se lee como un brillo. La base tiene que ser neutra para
que el efecto sea el efecto y no una mezcla.

**Lo que no cambia:** el subtítulo (`Clasificación de traders hispanos`) sigue en
su gris de siempre. La corrección era sobre la palabra del wordmark, no sobre él.

**Contraste, calculado:**

    antes  #598DB0 sobre #111315   5,20:1   AA
    ahora  #EDEDED sobre #111315  15,90:1   AA y AAA

Así que la excepción además mejora lo que el clon tenía. Con
`prefers-reduced-motion` la palabra queda **blanca fija**: se apaga el
pseudo-elemento entero en vez de congelar el degradado, porque un degradado
detenido sigue siendo una decoración que alguien pidió no ver — y porque
congelarlo cambiaría el color respecto del reposo.

## §9.1 El panel de wallets sale del flujo — 2026-09-05

El requisito de Fede sobre el desplegable era literal: *"la fila NO cambia;
debajo se abre un panel indentado"*. La primera implementación lo envolvía dentro
de `.identity-line`, y ahí la fila **sí** cambiaba: la línea crecía de 28 a 71 px,
el bloque se recentraba y el nombre bajaba 14 px al abrir. Medido por
`chain-columns.spec.ts` — `nameY` 201 → 215 — que es exactamente para lo que se
escribió ese caso.

El panel es ahora `position: absolute` contra `.wallet-cell`, y la tarjeta crece
por un `padding-bottom` que aplica `:has(.wallet-panel:not([hidden]))` sobre el
`<li>`. Las dos cosas que se pedían se cumplen a la vez: la primera línea no se
mueve un píxel y la tarjeta crece, así que las filas siguientes bajan.

`:has()` porque el estado abierto/cerrado vive en el panel, que es un componente
cliente **dentro** del `<li>`: no hay forma de poner una clase en el `<li>` desde
adentro sin subir el estado a la fila entera y volver cliente todo lo que hoy es
servidor. Chromium, Firefox y WebKit lo soportan desde 2023 y los tres corren en
la suite.

## §9.2 Un fixture no rompe el caso de otro

El seed de e2e le sumó una operación en otra cadena al KOL del índice 0 para
tener una fila con dos montos. Ese KOL es Ana Cripto, cuyos totales fija
`modal-kol.spec.ts` en `+18,42 SOL`: pasaron a `+19,92` y el caso ajeno se cayó
sin que nada en él hubiera cambiado.

La operación vive ahora en el último KOL de la lista, al que no mira ningún caso.
Para `chain-columns.spec.ts` sirve cualquier fila con dos montos — no necesitaba
la primera, solo la más fácil de escribir.

## §10 `Connect Wallet`, el modal — 2026-09-05

El molde tiene un chip de usuario logueado arriba a la derecha. Nosotros no
tenemos sesiones —spec §6 no da cuentas— así que el slot conserva **la
geometría** y cambia el contenido: mismo alto, mismo radio, mismo lugar, y
adentro la acción de conectar en vez de un avatar con un handle. Un chip con la
foto de alguien sería una sesión que este producto no tiene, que es la última
prohibición de `DESIGN.md`: *"no muestres un control que no funciona"*.

Desde el 2026-09-05 ese botón **abre un diálogo encima de la clasificación** en
vez de navegar. Lo que se copia del molde es la posición y la forma, no el
comportamiento: ellos llevan a una pantalla de wallet, nosotros abrimos algo de
lo que se sale con Esc y que deja la lista a la vista atrás.

**Las tres formas de cerrar son las de `modal-kol`** —Esc, clic en el fondo, la
× arriba— y eso no es pereza: un lector no aprende una convención de cierre
distinta por cada diálogo del mismo sitio.

**El relleno es el violeta de Phantom** (`#AB9FF2` con texto `#111315`), pedido
del dueño y el anglicismo `Connect Wallet` aceptado en `docs/copy.md`. Contraste
medido: **7,96:1** en reposo y **6,46:1** en hover, los dos por encima de AA para
texto normal y el primero por encima de AAA. El hover era una mezcla con
`--brand-hispano` que quedó de cuando el botón era translúcido — convertía el
relleno en un celeste transparente con texto oscuro encima, y era el único
estado del botón que no pasaba contraste.

## §11 Cómo el molde agrega una segunda wallet — 2026-09-06

**Medido por el dueño, no por mí.** Intenté leerlo desde afuera y no se puede:
a un cliente anónimo `kolscanbrasil.io` le contesta 404 en `/profile`,
`/settings`, `/account` y `/wallets`, y el único control de wallet en la página
pública es `Conectar Wallet`. El flujo vive detrás de su sesión. Las capturas
son de Fede, logueado como `@eguito`.

**Lo que muestran:**

- Un modal de perfil con **`Minhas Wallets`**.
- **`+ Adicionar` pega la dirección** — Solana o EVM — y **no pide firma**.
- Las que sí se firmaron aparecen bajo **`Solana (validadas)`**: la etiqueta
  pública existe sólo para las firmadas, y las pegadas no llevan contra-etiqueta.
- Un **ojo por wallet** para mostrarla u ocultarla, y un **`Ocultar todas`**.
- **`Atualizar PnL`** y **`Exportar PnL Card`**.

**Consecuencia para nosotros, y es un supersede.** El invariante era *"cada
wallet se prueba con su propia firma"*. El molde firma **una vez, para entrar**,
y las demás se anotan a mano. Se copia el molde: `DECISIONES.md`, 2026-09-06,
con el riesgo aceptado escrito ahí — un KOL puede anotar una wallet que no es
suya, y el admin puede darla de baja.

Las guardas que **no** cambian la UX y sí acotan el daño: una dirección sólo
puede pertenecer a un KOL (única por índice ciego, y si ya está tomada el
mensaje lo dice y va a la cola de admin), las agregadas sin firma llevan
`verified = false` interno y el admin las ve marcadas, y la visibilidad sigue
siendo por wallet.

## §12 `Cabals` es `DAOs` acá — 2026-09-07

El molde llama `Cabals` a los grupos, en el nav y en su página. **Este sitio los
llama `DAOs`**, por decisión del dueño, y es la única etiqueta donde el clon se
aparta del molde a propósito.

Lo que se mantiene del molde: la sigla de tres letras en la fila, el chip con su
color, la página con el mismo podio y la misma grilla. Lo que cambia es la
palabra — y adentro del código sigue siendo `cabal`, porque renombrar tablas y
acciones firmadas por una etiqueta costaría una migración y la invalidación de
cada firma emitida (`docs/copy.md`).
