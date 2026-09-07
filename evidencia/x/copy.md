# Cuenta de X de KOLScan Hispano

Preparado el 2026-09-06. **Sin handles personales en ningún archivo de esta
carpeta**, ni en las imágenes ni en el texto: la cuenta habla como producto.

## Imágenes

| Archivo | Uso | Nota |
|---|---|---|
| `avatar-400.png` | Avatar, 400×400 | La bandera **dibujada**, no la foto de `public/marca/espana.png`: a 48 px del timeline una foto se ensucia y las tres franjas no. Es el mismo dibujo del favicon, que es lo que hace que la pestaña y la cuenta se reconozcan como la misma cosa. Sobrevive el recorte circular de X (las esquinas del cuadrado quedan dentro del círculo) |
| `avatar-400-kh.png` | Avatar, alternativa | El monograma `KH` con la franja de bandera debajo. Se lee mejor a 24 px —el tamaño de una respuesta en un hilo— y peor como marca de país |
| `banner-1500x500.png` | Banner | Wordmark en blanco sobre `#111315`, el fondo del sitio. Las tres columnas de chain (SOL verde, ETH azul, BNB amarillo) van al 16% de opacidad, como detalle. Franja de bandera de 6 px al pie |

**Decisión abierta, tuya**: cuál de los dos avatares. La bandera dice de dónde es
antes de que nadie lea el nombre; el monograma se lee a cualquier tamaño. Están
los dos hechos para que la elección no cueste otra tanda.

Una nota sobre el banner: X monta el avatar sobre su esquina inferior izquierda y
recorta arriba y abajo en móvil. El wordmark está centrado, que es la zona que
sobrevive los dos recortes.

## Bio

La preferida, **122 caracteres**:

> Ranking de traders hispanos de memecoins. PnL realizado on-chain, Solana ·
> Robinhood · BNB. Tus wallets nunca se publican.

Tres variantes, todas ≤160:

1. **Más corta, 115.** Deja sitio al link y se lee de un vistazo en móvil.
   > Ranking de traders hispanos de memecoins. PnL realizado on-chain en Solana,
   > Robinhood y BNB. Tus wallets, privadas.

2. **La que promete menos, 129.** No dice «nunca», que es una palabra difícil de
   sostener; dice qué hace el producto y deja la promesa para la página.
   > Clasificación de traders hispanos por PnL realizado. Datos on-chain de
   > Solana, Robinhood y BNB. Tú eliges qué wallet se muestra.

3. **La que invita, 134.** Sirve mejor si la cuenta va a pedir registros.
   > El ranking de los traders hispanos de memecoins. PnL realizado, on-chain,
   > sin autoreportes. Regístrate firmando: no pagas nada. 🇪🇸🌎

**Recuento**: medido con el criterio de X, que cuenta cada emoji de bandera como
dos caracteres — por eso la variante 3 mide 134 y no 131. Las cuatro están
holgadas: la más larga usa 134 de 160.

**Español neutro, no rioplatense**, igual que la copia del sitio (`CLAUDE.md`):
«tú eliges», no «vos elegís»; «regístrate», no «registrate». La primera versión
de este archivo se escribió en rioplatense y se corrigió.

## Tweet fijado

Tres versiones. La 1 es la recomendada: dice qué es, qué no es, y qué hacer.

**1 — Directa**

> Ya está en línea KOLScan Hispano: el ranking de los traders hispanos de memecoins.
>
> · PnL realizado, calculado on-chain. Nada de autoreportes.
> · Solana, Robinhood y BNB.
> · Tus wallets no se publican, salvo que elijas mostrarlas.
>
> Entra y mira quién va ganando 👇
> kolscanhispano.fun

**2 — Por el problema**

> Todo el mundo tuitea sus ganancias. Nadie tuitea las pérdidas.
>
> KOLScan Hispano lee la cadena y arma el ranking con el PnL realizado: lo que
> cerró de verdad, no lo que dijo que cerró.
>
> Solana · Robinhood · BNB. Ya está online.
> kolscanhispano.fun

**3 — Por la privacidad**

> Un ranking de traders no debería obligarte a mostrar tu wallet.
>
> En KOLScan Hispano firmas un mensaje —nunca una transacción— y decides wallet
> por wallet cuál se ve. Las que no eliges no aparecen: ni la dirección, ni sus
> primeros caracteres.
>
> kolscanhispano.fun

## Antes de publicar

El sitio está con `noindex` a propósito hasta el lanzamiento
(`docs/lanzamiento.md`). Un tweet fijado que apunte al dominio **antes** de
sacarlo manda gente a una página que los buscadores no van a indexar y que
todavía puede cambiar. El orden es: quitar el `noindex`, `npm run prelaunch` en
verde, y sólo entonces fijar el tweet.
