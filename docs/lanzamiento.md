# Lanzamiento

Qué toca Fede, qué se verifica solo, y qué se mira después. La verificación
automática es `npm run prelaunch`; esta página existe para lo que un comando no
puede hacer.

## Antes: `npm run prelaunch`

Nueve verificaciones, **todas con llamadas reales**. Ninguna lee una variable de
entorno y concluye que algo funciona.

| Verifica | Cómo | Rojo cuando |
|---|---|---|
| Clave de Helius | `getHealth` contra su RPC | no responde 200 |
| Webhook de Helius | listado + detalle de su API | inactivo, o sin direcciones |
| Entrega | `raw_tx` en los últimos 30 min | no llegó nada |
| Webhook de Alchemy | listado de su API | hay wallets BNB y ningún webhook |
| Cron `sol_price` | el minuto más nuevo de la serie | hace más de 90 min |
| Blue de ARS | la marca de `setting['fx.ars']` | hace más de 6 h |
| PnL Card | **genera un PNG de verdad** | no es un PNG |
| Migraciones | las del checkout contra `schema_migrations` | falta alguna |
| `noindex` | pide la home y la lee | no está en el estado esperado |

**Por qué llamadas reales y no configuración.** El 2026-09-07 el cron de
`parse-pending` informó `refreshed 29 of 29` durante días mientras las 29
llamadas a Helius devolvían 401: contaba filas escritas, no respuestas
recibidas. Un check que dijera "la clave está configurada" habría dicho lo mismo
y también habría estado mal. Preguntarle a Helius es lo único que distingue una
clave puesta de una clave que sirve.

Corre además **todos los días a las 9 UTC** y abre un issue cuando falla
(`.github/workflows/prelaunch.yml`), porque un check que sólo corre cuando
alguien se acuerda es el que no corrió el día que importaba.

## El día del lanzamiento, lo que toca Fede

1. **Sacar el `noindex`, que son tres lugares y van juntos.** `layout.tsx`
   (`robots` en el metadata), `robots.ts` y el `PRELAUNCH_INDEXABLE` del
   repositorio. Los tres o ninguno: dos de tres deja el sitio a medio indexar y
   la contradicción tarda semanas en resolverse sola.

   Poner `PRELAUNCH_INDEXABLE=1` como *variable* del repositorio **invierte** el
   check en vez de apagarlo: a partir de ahí, `prelaunch` falla si el `noindex`
   todavía está.

2. **Los DMs a los KOL.** Doce sin wallet al 2026-09-05. El enlace que va en el
   mensaje es `kolscanhispano.fun/registro`, que abre el modal de conexión sobre
   la home y **conserva la URL** — por eso no es un 308.

3. **Confirmar el nombre de la clave de Helius** antes de borrar la vieja en el
   dashboard. `.env.local` no dice cuál es: el valor no lleva nombre y las dos
   pasan cualquier verificación de comportamiento. Borrar la equivocada apaga la
   ingesta.

## Después del lanzamiento, lo que se mira

- **`npm run prelaunch` con `PRELAUNCH_INDEXABLE=1`.** Mismo comando, expectativa
  invertida.
- **Webhooks vivos**: los cubre `prelaunch`, pero el primer KOL que se registre
  después del lanzamiento es la prueba real — su primera operación tiene que
  aparecer en el ranking sin que nadie toque nada.
- **Crons**: `parse-pending` cada 5 min y `fetch-fx` cada hora. Se miran por su
  **efecto** (`sol_price`, `fx.ars`), no por el tilde verde de Actions, por la
  razón de arriba.
- **ARS**: la home en pesos tiene que mostrar cifras y no `(—)`. Sin cotización
  muestra dólares con aviso, que es correcto pero no es lo que se quiere ver.
- **PnL Card**: la genera `prelaunch`; mirar una a ojo la primera vez, porque un
  PNG válido puede ser un PNG feo.

## Lo que este checklist no cubre

El operador con la clave y la base descifra todo, y ningún ítem de acá lo
cambia — `SECURITY.md` lo dice con la tabla de qué protege cada capa. Y
`prelaunch` mira lo que existe: no puede saber si falta una pieza que nadie
escribió todavía.
