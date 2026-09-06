# Qué cadena firma cada wallet — 2026-09-06

El selector muestra, por wallet, **las cadenas que esa wallet soporta de verdad**
— no las que se deducen de haber anunciado un handshake.

**La distinción es la que rompió el gate.** Phantom anuncia EIP-6963, así que el
código la listaba con un chip de Robinhood. Phantom no soporta Robinhood Chain.
Anunciar EIP-6963 quiere decir "hablo el protocolo de descubrimiento EVM", no
"puedo firmar en cualquier cadena EVM": las wallets de cadena fija soportan una
lista cerrada, y sólo las de RPC configurable (MetaMask, Rabby) aceptan una
cadena arbitraria como Robinhood (4663).

## La tabla

| Wallet | Solana | EVM | Nota |
|---|---|---|---|
| **Phantom** | sí | Ethereum, Base, Polygon | Lista cerrada. **No** Robinhood ni BNB. |
| **MetaMask** | no | cualquiera, por RPC | Robinhood (4663) y BNB entran como red personalizada. |
| **Rabby** | no | cualquiera, por RPC | Igual que MetaMask; declara decenas de cadenas. |
| **Backpack** | sí | Ethereum y compatibles | Multichain, lista más corta que MetaMask. |
| **Solflare** | sí | no | Sólo Solana. |

## Estado de verificación

**Sin verificar contra la fuente, y hay que decirlo.** Esta tabla se escribió el
2026-09-06 desde conocimiento previo, no desde las páginas oficiales: el sandbox
donde corre este trabajo tiene la salida a internet bloqueada (`ECONNREFUSED` a
todo host), así que no se pudo abrir ninguna de las fuentes de abajo.

Las fuentes a comprobar, una por fila:

- Phantom — `phantom.com`, sección de redes soportadas.
- MetaMask — `docs.metamask.io`, redes personalizadas.
- Rabby — `rabby.io`, lista de cadenas.
- Backpack — `backpack.app`.
- Solflare — `solflare.com`.

**Mientras esté sin verificar, el riesgo es acotado y asimétrico**: una fila de
menos es una wallet que el lector no puede elegir aunque podría; una de más es
un chip que promete una cadena en la que la firma va a fallar. Por eso las
entradas dudosas se escribieron **cortas** — Phantom con tres EVM y no con
"cualquiera" — que es el lado seguro del error.

## Cómo se usa

`WALLET_SUPPORT` en `src/lib/wallet-support.ts` es esta tabla en código, con el
nombre de la wallet como clave. Una wallet que no está en la tabla se muestra
con las cadenas que su handshake reportó, que es el comportamiento viejo y el
único posible para algo que no conocemos.
