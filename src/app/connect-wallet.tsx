"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { Chain } from "@/lib/chain";
import { RegistroForm } from "./registro/registro-form";

/**
 * `Connect Wallet` como **modal sobre la home**, no como página.
 *
 * Decisión del dueño, 2026-09-05: el botón del header abre un diálogo encima de
 * la clasificación en vez de llevarse al lector a otra pantalla. `/registro`
 * sigue existiendo como ruta directa —los DMs a los KOL la tienen escrita— y
 * **conserva la URL**: no hay 308, la ruta renderiza la home y abre este mismo
 * modal encima. Una sola implementación del flujo, dos formas de llegar.
 *
 * El contenido es `RegistroForm` sin tocar. Reimplementar el flujo adentro del
 * diálogo habría sido una segunda copia de la conexión, la firma y el código
 * del tweet — tres cosas que no pueden discrepar y que ya tienen sus tests.
 */

type ConnectApi = { open: () => void; close: () => void; isOpen: boolean };

/**
 * Las dos promesas, en dos líneas y una sola vez.
 *
 * En español neutro y no en el voseo del pedido (`Firmás`): `docs/copy.md`
 * prohíbe el voseo en toda superficie que vea un lector, y la excepción quedó
 * anotada ahí.
 */
export const CONNECT_LEAD =
  "Firmas un mensaje, no una transacción. Tus wallets nunca se publican salvo que elijas mostrarlas.";

const ConnectWalletContext = createContext<ConnectApi | null>(null);

/**
 * Lo usa el botón del header. Fuera del provider devuelve `null`, y el botón
 * se comporta como el enlace que es — navega a `/registro`, que funciona.
 */
export function useConnectWallet(): ConnectApi | null {
  return useContext(ConnectWalletContext);
}

export function ConnectWalletProvider({
  chains,
  children,
}: {
  /** Resuelto en el servidor: `activeChains()` lee `process.env`. */
  chains: readonly Chain[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  /*
    `/registro` abre el modal al entrar. Se mira el pathname y no un prop
    porque la ruta ya lo dice: dos fuentes para el mismo hecho es la forma en
    que un día dejan de coincidir.
  */
  const [open, setOpen] = useState(false);
  const openedFor = useRef<string | null>(null);

  useEffect(() => {
    if (pathname === "/registro" && openedFor.current !== pathname) {
      openedFor.current = pathname;
      setOpen(true);
    }
    if (pathname !== "/registro") openedFor.current = null;
  }, [pathname]);

  const close = useCallback(() => {
    setOpen(false);
    // Cerrar desde `/registro` devuelve la URL a la home, porque la home es lo
    // que queda a la vista. La ruta directa sigue sirviendo para llegar.
    if (pathname === "/registro") router.replace("/");
  }, [pathname, router]);

  const api: ConnectApi = { open: () => setOpen(true), close, isOpen: open };

  return (
    <ConnectWalletContext.Provider value={api}>
      {children}
      {open && <ConnectWalletDialog chains={chains} onClose={close} />}
    </ConnectWalletContext.Provider>
  );
}

/**
 * El diálogo, con la estructura que usa la industria.
 *
 * Medido contra RainbowKit (`rainbowkit.com`) y Reown AppKit
 * (`docs.reown.com`), que son los que usan Uniswap, Jupiter y pump.fun. Lo que
 * se copia es la **forma**, que es donde estaba el problema:
 *
 *   - **Abre directo en la lista.** No hay un botón `Connect Wallet` adentro de
 *     un modal que se abrió con `Connect Wallet`: el paso previo no decidía
 *     nada. Fue lo primero que el dueño marcó.
 *   - **Una caja de ~400 px que crece con el contenido**, no una pantalla alta
 *     con aire abajo.
 *   - **Dos secciones**: `Instaladas`, detectadas por Wallet Standard y
 *     EIP-6963 con su ícono real; y `Otras`, las que no están, con su enlace de
 *     instalación.
 *   - **Un solo texto**, de dos líneas. Antes había dos párrafos que decían lo
 *     mismo con distintas palabras.
 *
 * Los estados —conectando, error, wallet equivocada— pasan **en este mismo
 * panel**. Un segundo diálogo encima del primero fue el otro problema del gate.
 */
function ConnectWalletDialog({
  chains,
  onClose,
}: {
  chains: readonly Chain[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal-connect"
      aria-labelledby="connect-title"
      /*
        **Esc lo maneja el `<dialog>`, no un listener en `document`.**

        La primera versión escuchaba `keydown` en `document`, y eso cerraba
        **este** modal aunque el que estuviera arriba fuera el selector de
        wallets de adentro: en `/registro`, Esc tenía que cerrar el selector y
        se llevaba puesto el formulario entero. Lo encontró
        `registro-wallets.spec.ts`.

        Un `<dialog>` abierto con `showModal()` ya recibe Esc como `cancel`, y
        **sólo lo recibe el de más arriba de la pila**. O sea que la anidación
        la resuelve la plataforma, que es justo lo que un listener global
        rompía. `wallet-picker.tsx` usa exactamente este mecanismo.
      */
      onCancel={(event) => {
        /*
          **Sólo si el `cancel` es de este diálogo.**

          El DOM no propaga `cancel`, pero React sí: su sistema de eventos
          sintéticos simula el burbujeo por el árbol de componentes, y el
          selector de wallets vive **adentro** de este diálogo. Así que un Esc
          sobre el selector disparaba su `onCancel` y, acto seguido, éste — el
          selector se cerraba y se llevaba puesto el formulario entero.

          Comparar contra `ref.current` es lo que separa "me cancelaron a mí" de
          "cancelaron a alguien que tengo adentro".
        */
        if (event.target !== ref.current) return;
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Sólo el fondo: un clic adentro de la tarjeta no cierra nada.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-card connect-card">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          {/* U+00D7, no una equis minúscula. */}×
        </button>

        <h2 id="connect-title" className="connect-title">
          Conecta tu wallet
        </h2>

        {/*
          **La línea la dice la lista, no este diálogo.** Acá se repetía en cada
          paso —chain, `Casi listo`— y para entonces el lector ya la leyó. Vive
          en `wallet-step.tsx`, que es el paso donde todavía no decidió nada.

          Las dos promesas las verifica un test: `no-money-path.test.ts` la firma
          sin transacción, `address-invariant.test.ts` que ninguna dirección no
          pública llegue a una superficie pública.
        */}
        <RegistroForm chains={chains} />
      </div>
    </dialog>
  );
}
