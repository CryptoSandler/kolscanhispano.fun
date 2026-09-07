# Credenciales: qué cuenta las emite

Escrito el 2026-09-06, después de encontrar una key de la cuenta **personal** de
Fede en producción, en preview y en el secret de CI de este repo.

## La regla

Toda credencial de este repo la emite una cuenta **CryptoSandler**. Nunca una
cuenta personal.

No es higiene: una key lleva el ID de la cuenta que la emitió, y esa cuenta tiene
nombre, mail y facturación. Una credencial personal en un repo público es un
no-doxx roto por un camino que ninguna revisión del código mira.

## Prefijos permitidos

Un **prefijo** de key ID es lo que se escribe acá; el valor completo no aparece ni
en este archivo ni en ningún otro del repo. Ocho caracteres de un UUID dejan más
de noventa bits sin adivinar: identifican la key, no la abren. Es el mismo trato
que Stripe o AWS le dan a sus key IDs.

| Servicio | Variable | Cuenta | Prefijo permitido |
|---|---|---|---|
| Helius | `HELIUS_API_KEY` | CryptoSandler (`kolscanhispano-server-2`) | `1c9346f2` |
| Alchemy | `ALCHEMY_BNB_RPC_URL` | CryptoSandler (proyecto `arrival`) | `alch_t7gz8` |
| SolanaTracker | `SOLANATRACKER_API_KEY` | CryptoSandler | `4d41c3e6` |

Otras keys de la **misma cuenta CryptoSandler**, que viven en otros repos de esta
máquina. No las usa este proyecto —el check de acá sigue pidiendo `1c9346f2` para
`HELIUS_API_KEY`, una key por repo— pero se anotan para que un barrido por
prefijo sepa que no son hallazgos:

| Prefijo | Servicio | Dónde |
|---|---|---|
| `2d515c52` | Helius, key `arrival` | `smartmoney` |

Revocado, y prohibido de volver:

| Prefijo | Qué era | Cuándo |
|---|---|---|
| `a0336760` | Helius, cuenta **personal** de Fede | rotada y revocada el 2026-09-06 |

## Quién lo comprueba

`npm run prelaunch` compara el prefijo de la key que el server usa **de verdad**
contra esta tabla, y falla nombrando el servicio si no está. Es la única forma de
cerrar el caso: el incidente de hoy no fue una key mal escrita en un archivo, fue
una key correcta en el archivo y otra distinta arriba.

Al rotar, **se lee `.env.local`, nunca `process.env`** — `node --env-file` no pisa
una variable ya exportada por la shell, y ése fue exactamente el camino por el que
la key personal llegó a Vercel. Está en `~/.claude/GATES.md`.
