# Colores de chain: dos tablas, y de dónde sale cada hex

Verificado el 2026-09-06 contra las fuentes oficiales de cada marca. Cada hex de
la tabla de marca lleva la fuente al lado; los que no tienen fuente publicada lo
dicen.

## Marca — el color que la chain usa para sí misma

Se usa donde el nombre de la chain aparece **como nombre**: el modal de elección
de chain y los badges con texto.

| Chain | Hex | Fuente |
|---|---|---|
| Solana | `#9945FF` → `#14F195` (degradado) | [solana.com/branding](https://solana.com/branding) — «Solana Purple» y «Solana Green», y el degradado entre los dos es parte de la identidad |
| Ethereum | `#627EEA` | Guía de marca de la Ethereum Foundation. `ethereum.org/en/assets` publica los archivos pero **no el hex**; éste es el del rombo morado oficial y el que la propia guía externa cita |
| BNB Chain | `#F0B90B` | [bnbchain.org, brand guidelines](https://www.bnbchain.org/en/brand-guidelines) — «Hex: #f0b90b», Pantone 116C |
| Base | `#0000FF` | [brand.base.org/color](https://brand.base.org/color) — «Base Blue is screen native RGB 0 0 255» |
| Robinhood | `#CCFF00` | **Sin hex publicado.** El press kit nombra «Robin Neon: a bright yellow green unique to Robinhood» y no da el valor. `#CCFF00` está muestreado del CSS de `robinhood.com` (19 apariciones el 2026-09-06). Es de primera mano, pero no es una promesa de la marca: si publican uno, gana el suyo |

## Ranking — el color que ordena las columnas

Se usa en las columnas de la clasificación y en los montos por chain. **No son
los de marca a propósito**, y el motivo está en `DESIGN.md` §3.

| Chain | Variable | Valor |
|---|---|---|
| Solana | `--chain-solana` | `rgb(74 222 128)` |
| Ethereum | `--chain-ethereum` | `rgb(96 165 250)` |
| BNB | `--chain-bnb` | `rgb(250 204 21)` |
| Robinhood | `--chain-robinhood` | `rgb(45 212 191)` |

## Por qué dos y no una

Las de ranking vienen del molde —SOL verde, ETH azul, BNB amarillo— y su trabajo
es **distinguir columnas de un vistazo sobre fondo oscuro**: tienen que
diferenciarse entre sí y pasar contraste AA, y no tienen que parecerse a nada.
Base Blue `#0000FF` sobre `#0B0D0F` es ilegible, y el morado de Solana al lado
del azul de Ethereum se confunde en una fila de números.

Las de marca tienen el trabajo contrario: cuando el nombre de la chain aparece
como nombre —«Solana», «Base»—, el lector espera el color de esa marca, y
cualquier otro se lee como un error.

Una sola tabla habría tenido que fallar en uno de los dos trabajos.
