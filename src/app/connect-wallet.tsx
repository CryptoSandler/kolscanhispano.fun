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
 * El diálogo. Las tres formas de cerrarlo son las que `DESIGN.md` le exige a
 * `modal-kol` — Esc, clic en el fondo, botón — porque un lector no aprende una
 * convención distinta por modal.
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
      <div className="modal-card">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Cerrar">
          {/* U+00D7, no una equis minúscula. */}×
        </button>

        <h2 id="connect-title" className="headline">
          Conecta tu wallet
        </h2>

        {/* La línea de privacidad la renderiza `RegistroForm`, una sola vez:
            estaba acá **y** ahí, y se veía dos veces seguidas. */}
        <RegistroForm chains={chains} />
      </div>
    </dialog>
  );
}
