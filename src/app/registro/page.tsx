import HomePage from "../page";

/**
 * `/registro` — spec §6, la única ruta del producto que conecta una wallet.
 *
 * **Desde el 2026-09-05 renderiza la home y el modal se abre encima.** La
 * decisión del dueño fue que `Connect Wallet` sea un modal y no una pantalla, y
 * que esta ruta siga existiendo **con su URL**: está escrita en los DMs a los
 * KOL, y un 308 a la home la convertiría en un enlace que ya no lleva a lo que
 * prometía. Así que no hay redirect — hay una página que muestra lo que hay
 * abajo del diálogo, que es la clasificación.
 *
 * Quién abre el modal: `ConnectWalletProvider`, mirando el pathname. Vive en el
 * layout, así que esta ruta no tiene que decir nada.
 *
 * **El wrapper de `activeChains()` se mudó al layout**, no desapareció. El
 * motivo por el que existía sigue vigente palabra por palabra: `activeChains()`
 * lee `CHAIN_ROBINHOOD_INGESTION` de `process.env` y el formulario es un
 * componente cliente, así que llamarla ahí devolvía `["solana"]` dijera lo que
 * dijera el flag, y la mitad EVM del selector de wallets no corría nunca.
 * Fallaba con la cara de una feature apagada, que es la razón por la que hizo
 * falta manejar la página con una wallet falsa para verlo. Un solo valor,
 * resuelto en el servidor y pasado como prop, sigue siendo la respuesta.
 */
export default HomePage;
