# The round before `1D · 7D · 30D`

`CLAUDE.md`: *"Any change to the model — what a number means, what a rule decides — and any
large product decision gets one round **without code** first."* This is the change that rule
was written for: it does not alter how a figure is drawn, it alters what every figure on the
product means.

The owner has decided **that** it happens. This round is about what it costs and what it
breaks, and it is written before the code.

---

## 1. The strongest case against

**The same label will mean a different measurement, and nobody will be told.** `Diario` means
"this UTC day" today and would mean "the last 24 hours" tomorrow. Every screenshot anyone has
taken, every figure quoted in a tweet, every number a KOL has seen beside their name changes
retroactively. There is no version marker on a PnL.

**A rolling window has no answer to "who won today".** That is the question a leaderboard
exists to answer, and a calendar day is what makes it answerable: two KOLs are compared over
the *same* interval, and the interval is one every reader already shares. Under a rolling
window the ranking drifts continuously — a screenshot at 10:00 and one at 11:00 disagree with
no trade in between, because a trade aged out of the window. Nothing is wrong, and it reads as
data moving when nothing has, which is the exact defect `k.slug ASC` was added to `ORDER BY` to
prevent at a smaller scale.

**The mould is not evidence that the mould reasoned about it.** The same reconnaissance that
recorded `1D · 7D · 30D` also recorded that their window toggle ships in English on one page
and Portuguese on another, and that two of the four blocks in their KOL modal render empty
(`docs/clone-map.md` §0). This project already refuses to reproduce their defects. A window
semantics copied because it is theirs, rather than because it is right, is the same act.

**It is the one clone row with a database migration under it**, and migrations here are the
expensive kind: three databases in the same close, a Neon branch from `production`, and a
backfill that replays every position in the roster.

**And the calendar is load-bearing beyond the toggle.** `card-calendario-pnl` draws one cell
per UTC day of the window and aligns them into weeks; `sin precio`, `sin cierres` and the
empty-state rule are all defined over "the window"; the win rate is closed positions *in the
window*. A rolling 30 days is drawable but stops being a calendar, and the block stops being
the mould's calendar too.

## 2. The collision with the real code

Read, not remembered:

- **`pnl.ts:297`, the sentence that decides everything**: *"Spec §4.7: realized PnL is
  bucketed by the timestamp of the sell"* — `dayTotals(state, utcDay(trade.block_time))`. The
  realized amount is computed **per sell** and then added into a **UTC day** bucket.
- **`pnl_daily` is `PRIMARY KEY (kol_id, day)`** and `pnl_position_daily` is the same shape one
  level down. The finest grain that survives the replay is a day.
- **So a rolling `1D` cannot be computed from what is stored.** Not approximately, not
  awkwardly — the information is gone. `7D` and `30D` can be approximated by summing the last
  seven or thirty daily buckets, but that is "the last N calendar days", which on a Monday
  morning includes a today that is minutes old. It is a different number wearing the label.
- **The information exists at replay time and is discarded.** `replayPosition` knows
  `netSol - removedSol` for each sell before it buckets it. Persisting that — a column on
  `trade`, or a table keyed by the sell's signature — makes every window, rolling or calendar,
  a `SUM ... WHERE block_time >= $1`, and makes the two kinds of window cost the same.
- **`windows.ts` returns calendar bounds** and `utcDayString` hands `date` literals to the
  query; `leaderboard.ts`, `kol.ts` and `cabals.ts` all sum `pnl_daily` between two `date`s.
  Rolling windows need `timestamptz` bounds and a different table to sum.
- **`docs/spec-v1.md` §4.9 fixes calendar alignment**, `DESIGN.md` states it, and
  `card-calendario-pnl`'s own docstring argues from it. All three move.
- **The published API changes.** `/api/leaderboard?window=diario` is a URL people have; the
  values would become `1d`, `7d`, `30d`, or `diario` would keep its name and lose its meaning.
  The second is worse.
- **`e2e/viewport.spec.ts` and `windows.test.ts` pin the calendar boundaries**, including the
  Monday case that exists precisely because `Semanal` is one day long on a Monday.

## 3. Recommendation

**Build it, and build it exactly — but as an addition, not a replacement, and not in the same
batch as a visual audit.**

1. **Persist the per-sell realized figure.** One migration: `trade.realized_sol` and
   `trade.realized_usd`, written by `replayPosition` where it currently buckets, `NULL` for a
   buy. Every window then sums the same column over different bounds, and the daily tables stay
   exactly as they are — they are still what the calendar heatmap and the win rate read.
2. **Add `1d · 7d · 30d` beside `diario · semanal · mensual`**, do not overwrite them. Six
   values on one parameter, each honest about what it measures, and the label says which:
   `Últimas 24 h` is not `Hoy` and should not pretend to be.
3. **The backfill is a replay**, which this product already does on demand: mark every position
   dirty and let `recomputeDirty` walk them. No new machinery.
4. **Nothing on the calendar card changes.** It spans a calendar window; a rolling window
   selects a different card, or none.

**And the honest reservation, which is the part I am least willing to soften:** if the owner's
goal is that this site *looks* like the mould, the rolling windows are the one row where
matching the look costs a measurement the product currently gets right. Everything else in
`docs/clone-map.md` is paint. This is not. If it were my call I would ship the six-value
toggle, watch which three people actually use, and delete the pair nobody touches — but it is
not my call, and the mechanism above is the same either way.

## 4. Approved by the owner, 2026-09-02

The recommendation above was taken, with one thing settled that this round had left open:
**the six values are the product**, not a transition to three. The toggle shows
`Diario · Semanal · Mensual · 1D · 7D · 30D`, each saying what it measures, and the control
keeps kolscanbrasil.io as its visual mould.

What the next close carries:

- **A migration on `trade`**: `realized_sol` and `realized_usd` per **sell**, `NULL` for a buy
  and for a sell whose basis is unknown (spec §4.5 withholds those from `pnl_daily` too, and
  the two must withhold the same ones or the drift check below is meaningless).
- **`replayPosition` writes them** where it currently only buckets. It already computes
  `netSol - removedSol` per sell; today that number is added into a day and forgotten.
- **A full replay**: every position marked dirty, drained by `recomputeDirty`. No new
  machinery.
- **Three databases in the same close**, and a Neon branch from `production` for the branch,
  per `CLAUDE.md`.
- **The tooltip carries the semantics.** `Diario` is a calendar day UTC and `1D` is the last
  24 hours; a reader who does not open a tooltip must still not be misled, so the labels stay
  distinct rather than one set being relabelled.

### The drift check, and how to run it so it means something

**The sum of the per-sell figures must equal `pnl_daily` per KOL, before and after.** The
"before" was captured on 2026-09-02 against production, in
`~/proyectos/evidencia/kolscanhispano/2026-09-02-trabajo/drift-antes.json`:

    k4yeSol      +2.536981831            11 wins / 17 losses
    Stigman__    -9.541279230790240828    0 wins /  9 losses
    mambatrades_ no rows — nothing closed

**Both sides have to be read in one statement, not two.** Trades are arriving every few
minutes and each one changes both totals; two queries a second apart would show a difference
that is new data rather than drift, and it would look exactly like the bug the check is for:

    SELECT k.x_handle,
           (SELECT sum(t.realized_sol) FROM trade t WHERE t.kol_id = k.id) AS por_venta,
           (SELECT sum(d.realized_sol) FROM pnl_daily d WHERE d.kol_id = k.id) AS por_dia
      FROM kol k ORDER BY k.x_handle;

A non-zero difference is not a rounding question: both sides are `numeric` and both come from
the same `replayPosition` arithmetic, so they either agree exactly or one of them is wrong.

**On sequencing, and this is a recommendation about process rather than about windows:** a
migration on `trade` in production, a full replay of every position, and a visual audit
delivered in one batch straight to production is three risks sharing one rollback. The audit's
"se copia" rows are paint and can go out today; this should be its own close, with its own Neon
branch and its own three-database migration.


## 5. Enmienda del dueño, 2026-09-03: las móviles son las únicas

La decisión de §4 —*"the six values are the product"*— duró un día. **Fede decidió que
`Diario · Semanal · Mensual` desaparecen del producto y `1D · 7D · 30D` son las únicas ventanas**,
en toda la superficie: el toggle de la home, el del modal y el de `/cabals`. La home vuelve a
cinco opciones, `USD · ARS | 1D · 7D · 30D`, que es el control de kolscanbrasil.io.

Lo que eso cambia respecto de lo escrito arriba:

- **§3.2 queda revertido.** Ya no se agregan al lado de las de calendario: las reemplazan. El
  argumento de §3.2 era que `Últimas 24 h` no es `Hoy` y no debe fingir serlo — sigue siendo
  cierto, y ahora se resuelve quitando el par en vez de mostrarlo, que es la otra forma de que
  nadie los confunda.
- **§1 sigue en pie y hay que decirlo.** *"A rolling window has no answer to 'who won today'"* era
  el argumento más fuerte en contra y no fue refutado: fue **aceptado y descartado**. Este producto
  ya no contesta "quién ganó hoy"; contesta "quién viene ganando". Es una decisión de producto, no
  un descubrimiento de que el argumento estaba mal, y queda anotada así para que nadie la lea como
  resuelta.
- **§3.4 ya estaba enmendado** por el brief del modal: el calendario abarca un mes navegable e
  independiente de la ventana, y por eso imprime su propio total.
- **`/cabals` suma las móviles**, que en §3 se había dejado afuera. Pudo hacerse porque
  `migrations/015` ya guarda el realizado por venta: `cabals.ts` suma la misma columna que
  `leaderboard.ts`, así que el total de un cabal y la suma de las filas de sus miembros no pueden
  discrepar.

**Las URLs viejas no se rompen.** `?window=diario|semanal|mensual` fueron URLs publicadas durante
semanas y contestan con un **308** a `1d|7d|30d`. Permanente y no temporal porque el valor viejo no
vuelve; y un redirect y no un `400` porque esas URLs eran correctas cuando se hicieron. El mapeo es
por *duración*, que es la única correspondencia honesta disponible — no es una equivalencia, y por
eso las etiquetas nunca compartieron nombre.

**Y `sin cierres` dejó de existir por fila.** Era `winRate === null` — *"esta ventana no cerró
nada para este KOL"* — y le decía al lector que un `0,00` era **ausencia** y no un empate medido.
`winRate` sale de `wins`/`losses` de `pnl_daily`, que cuentan una posición *cerrada* por día UTC
(spec §4.8); una ventana móvil suma ventas sobre un intervalo arbitrario y no puede producirlos,
así que ahora es nulo para todos y no distingue nada. En el payload, `preview-hilofino` —que sólo
compró— y `preview-velacorta` —que cerró tres viajes de ida y vuelta y perdió los tres— son
indistinguibles: ambos imprimen `0`.

Dos atenuantes y una precaución. La fila **ya no lo mostraba**: las columnas de récord salieron de
la card el 2026-09-02 con la decisión de clon, así que ninguna superficie lo renderiza desde
entonces. Y la respuesta a nivel **tablero** sobrevive: `readLeaderboard` cuenta lo que
efectivamente sumó y publica `closed`, que es lo que lee el estado vacío del panel. La precaución
es que nadie re-derive el récord desde las ventas y lo llame tasa de acierto: sería otra medición
usando ese nombre, que es exactamente la sustitución que esta ronda existe para impedir.

**Lo que se perdió y conviene tener escrito:** `windows.test.ts` fijaba el domingo de la semana
ISO, el cruce de año y el febrero bisiesto, y eran las pruebas más filosas del archivo porque una
ventana de calendario tiene bordes que equivocar. Una móvil no tiene ninguno. Esas pruebas se
reemplazaron por las propiedades que *sí* pueden fallar ahora — que la ventana termina en el
instante del llamador al milisegundo y no en uno redondeado, que un día son exactamente 86.400.000
ms, y que ningún accesor de hora local se toca — y esa última es la única que sobrevive igual.
