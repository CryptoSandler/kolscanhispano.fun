# Qué cadena firma cada wallet — verificado 2026-09-06

El selector muestra, por wallet, **las cadenas que esa wallet soporta de verdad**
— no las que se deducen de haber anunciado un handshake.

Anunciar EIP-6963 quiere decir "hablo el protocolo de descubrimiento EVM", no
"puedo firmar en cualquier cadena EVM": las wallets de cadena fija soportan una
lista cerrada, y sólo las de RPC configurable (MetaMask, Rabby) aceptan una
cadena arbitraria como red personalizada.

## La tabla

| Wallet | Solana | EVM | Robinhood (4663) | Custom RPC | Fuente |
|---|---|---|---|---|---|
| **Phantom** | sí | Ethereum, Base, Polygon, HyperEVM, **Robinhood Chain** (+ testnets). Monad deprecado; Sui se deprecia el 24-sep-2026. También Bitcoin. | **sí, nativo** | **no** — "You can't add new or custom networks to Phantom manually." | [docs.phantom.com](https://docs.phantom.com/) · [EVM getting started (chain IDs)](https://docs.phantom.com/ethereum-monad-testnet-base-and-polygon/getting-started) · [help: redes custom](https://help.phantom.com/hc/en-us/articles/46595961428627-Can-I-manually-add-a-network-to-Phantom) |
| **MetaMask** | **sí** (Extension ≥13.5 / Mobile ≥7.57) | cualquiera, por RPC | sí, como red personalizada | sí — `wallet_addEthereumChain` (EIP-3085) | [wallet_addEthereumChain](https://docs.metamask.io/metamask-connect/evm/reference/json-rpc-api/wallet_addEthereumChain/) · [manage networks](https://docs.metamask.io/metamask-connect/evm/guides/manage-networks/) · [Solana en MetaMask](https://support.metamask.io/configure/networks/navigating-solana/) |
| **Rabby** | no | cualquiera, por RPC | sí, como red personalizada | sí — More → Add Custom Network; `wallet_addEthereumChain` abre popup de aprobación | [README "Ethereum and all EVM chains"](https://github.com/RabbyHub/Rabby) · [customTestnet.ts](https://github.com/RabbyHub/Rabby/blob/develop/src/background/service/customTestnet.ts) · [controller.ts (wallet_addEthereumChain)](https://github.com/RabbyHub/Rabby/blob/develop/src/background/controller/provider/controller.ts) · [pedido de Solana abierto](https://github.com/RabbyHub/Rabby/issues/2585) |
| **Backpack** | sí | Ethereum, Optimism, Arbitrum, Polygon, Base, Sonic ("more on the way") | **no** | no — sólo RPC custom para las redes ya listadas | [Add Network](https://support.backpack.exchange/wallet/actions/add-network.md) · [Custom RPC address](https://support.backpack.exchange/wallet/actions/custom-rpc-address.md) |
| **Solflare** | sí | no | no | no | [docs.solflare.com](https://docs.solflare.com/solflare) ("universal access to the Solana blockchain") · [solflare.com](https://www.solflare.com/) |

## Qué cambió respecto de la tabla del 2026-09-06 (sin verificar)

- **Phantom SÍ soporta Robinhood Chain (4663 / 0x1237) de forma nativa**, con
  testnet 46630. La premisa de "Phantom no soporta Robinhood" era falsa: el
  chip de Robinhood en Phantom que rompió el gate era correcto. Sigue siendo
  lista cerrada — lo que Phantom no permite es agregar redes arbitrarias, así
  que BNB u otra que no esté en la lista siguen afuera.
- Phantom suma HyperEVM y Bitcoin; Monad está deprecado y Sui se deprecia el
  24-sep-2026.
- **MetaMask soporta Solana** desde julio 2025 (Extension ≥13.5, Mobile ≥7.57).
  La columna Solana de MetaMask pasa de "no" a "sí".
- Backpack: lista concreta (Ethereum, Optimism, Arbitrum, Polygon, Base,
  Sonic), no "Ethereum y compatibles". No admite redes custom, sólo cambiar el
  RPC de una red ya soportada. Eclipse no figura en la doc oficial de la wallet.
- Rabby: confirmado sin Solana (issue #2585 abierto sin respuesta) y con red
  personalizada tanto desde la UI como vía `wallet_addEthereumChain` con popup.
- Solflare: confirmado sólo Solana.

## Logos — `public/wallets/`

Descargados el 2026-09-06 desde los repos/CDNs oficiales. La salida a internet
del sandbox y del VM local estaba bloqueada para los CDNs, así que se bajaron
desde github.com (raw) vía el navegador; el archivo es byte a byte el del
origen indicado.

| Archivo | Formato | Origen (URL exacta) | Brand page oficial | Licencia / permiso de uso |
|---|---|---|---|---|
| `metamask.svg` | SVG 35×34 | https://github.com/MetaMask/metamask-extension/raw/main/app/images/logo/metamask-fox.svg (ícono que usa la extensión) | https://metamask.io/assets — ofrece `MetaMask-icon-fox.svg` en images.ctfassets.net (mismo ícono; CDN bloqueado desde acá, cámbialo si querés el archivo de ahí) | **Sin permiso explícito.** metamask.io/assets no publica términos; los [Terms of Use](https://legal.consensys.io/metamask/terms-of-use/) §7.3 dicen "You will not use Our Marks unless you obtain our prior written consent". Uso de facto universal en botones "Connect wallet" (RainbowKit, wagmi, etc.). Riesgo: bajo, pero no es una licencia. |
| `rabby.svg` | SVG 512×512 | https://raw.githubusercontent.com/RabbyHub/logo/master/symbol.svg | https://github.com/RabbyHub/logo ("Brand assets for Rabby") | Repo de logos **sin LICENSE ni README**. La [LICENSE de la extensión](https://github.com/RabbyHub/Rabby/blob/develop/LICENSE) (MIT) dice: "Brand name and logo of Rabby is copyright reserved. You can not use brand name or logo of Rabby for your re-publish software" — prohíbe rebrandear forks, no habla del botón de conexión. Rabby publica su propio kit de conexión (RabbyKit) que muestra logos de wallets. |
| `phantom.svg` | SVG 108×108 | https://github.com/anza-xyz/wallet-adapter/raw/master/packages/wallets/phantom/src/adapter.ts (data URI `icon`, decodificado) | https://docs.phantom.com/resources/assets — "For most dapp integrations, we recommend using the following icon in SVG or PNG format" (mismo ícono; CDN mintcdn.com bloqueado desde acá) | **Permiso implícito para dapps** en la página de assets (cita arriba). Los [Terms](https://phantom.com/terms) reservan las marcas ("prior written consent"), pero la página de developers entrega el ícono justamente para integraciones. |
| `solflare.svg` | SVG 50×50 | https://github.com/anza-xyz/wallet-adapter/raw/master/packages/wallets/solflare/src/adapter.ts (data URI `icon`, decodificado) | https://www.solflare.com/solflare-brand-kit.zip (link "Brand Kit" del footer; ZIP no descargable desde acá) | **Sin permiso explícito.** [Terms](https://www.solflare.com/terms/): "You must not use Solrise IP without our prior written consent". El ícono está publicado en el wallet-adapter oficial de Solana, que es lo que toda dapp Solana usa. |
| `backpack.png` | PNG 128×128 (no hay SVG del ícono; el único SVG del repo es el wordmark) | https://github.com/coral-xyz/backpack/raw/master/packages/wallet-standard/src/icon.ts (data URI `icon` del wallet-standard, decodificado) | https://backpack.app/media-kit (Google Drive, no accesible desde acá) | **Sin permiso explícito.** [Terms](https://backpack.app/terms.pdf): "The Terms do not grant you any rights to use any 200ms Labs Brand Features". El repo es GPL-3.0 (código), sin licencia de marca aparte. Es el ícono que Backpack mismo expone por Wallet Standard para que las dapps lo muestren. |

**Lectura práctica:** ninguna de las cinco publica una licencia de logo tipo
"usalo libremente en tu botón de conectar". Phantom es la única que lo entrega
explícitamente "para integraciones de dapps". Las otras cuatro exponen el ícono
por Wallet Standard / EIP-6963 (`provider.info.icon`) precisamente para que las
dapps lo rendericen, que es la práctica estándar del ecosistema. Si algún día
pinta el problema, la salida limpia es usar el `icon` que la propia wallet
anuncia en el handshake en vez del archivo local.

## Cómo se usa

`WALLET_SUPPORT` en `src/lib/wallet-support.ts` es esta tabla en código, con el
nombre de la wallet como clave. Una wallet que no está en la tabla se muestra
con las cadenas que su handshake reportó, que es el comportamiento viejo y el
único posible para algo que no conocemos.

**Pendiente de código tras esta verificación:** `WALLET_SUPPORT` tiene a Phantom
sin Robinhood y a MetaMask sin Solana; hay que actualizarlo para que coincida
con la tabla de arriba.
