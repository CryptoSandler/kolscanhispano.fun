"use client";

import { useConnectWallet } from "./connect-wallet";

/**
 * El botón `Connect Wallet` del header.
 *
 * **Sigue siendo un enlace a `/registro`**, y eso es deliberado: se puede
 * copiar, abrir en una pestaña nueva y funciona sin JavaScript, que es lo que
 * un `<button>` habría perdido. El clic normal lo intercepta el provider y abre
 * el modal encima de la home; un clic con Cmd, Ctrl o el botón del medio se
 * deja pasar, porque el lector pidió otra pestaña y no un diálogo acá.
 */
export function ConnectWalletButton() {
  const connect = useConnectWallet();
  return (
    <a
      className="registro"
      href="/registro"
      onClick={(event) => {
        if (connect === null) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (event.button !== 0) return;
        event.preventDefault();
        connect.open();
      }}
    >
      Connect Wallet
    </a>
  );
}
