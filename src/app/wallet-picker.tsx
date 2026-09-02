"use client";

import { useEffect, useRef } from "react";
import type { StandardWallet } from "@/lib/wallet-standard";

/**
 * The chooser `/registro` opens once it knows which wallets are installed.
 *
 * **It renders what discovery found and nothing else.** There is no list in this
 * file, no ordering by preference and no name anywhere: a wallet is a row
 * because it registered itself and declared a Solana chain and message signing
 * (`wallet-standard.ts`), so the day a reader installs a new one it appears here
 * with no change to this repository.
 *
 * A native `<dialog>`, for the reasons `kol-modal-host.tsx` already sets out —
 * the platform gives focus trapping, `Esc`, inertness of the page behind, and
 * the top layer, and every one of those is a thing to get wrong by hand.
 *
 * The wallet's own icon is rendered when it ships one. It is a `data:` URI in
 * every wallet observed, which is why it can be used directly: it is not a
 * request to a third party, so it does not put anyone in the reader's request
 * path. A wallet with no icon gets its initial, the same fallback the avatar
 * takes.
 */
export function WalletPicker({
  wallets,
  onPick,
  onCancel,
}: {
  wallets: readonly StandardWallet[];
  onPick: (wallet: StandardWallet) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
  }, []);

  return (
    <dialog
      className="modal-wallets"
      ref={ref}
      aria-labelledby="wallet-picker-title"
      // `Esc` and the backdrop both mean "not now", and both land here rather
      // than leaving a dialog the page thinks is still open.
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onCancel();
      }}
    >
      <div className="wallet-card">
        <header className="card-head">
          <h2 className="headline" id="wallet-picker-title">
            Elige tu wallet
          </h2>
        </header>

        <ul className="wallet-choices">
          {wallets.map((wallet) => (
            <li key={wallet.name}>
              <button
                type="button"
                className="wallet-choice"
                onClick={() => onPick(wallet)}
              >
                {wallet.icon ? (
                  // The name is already the button's text, so the icon is
                  // decorative and announcing it twice would be noise.
                  <img alt="" aria-hidden="true" className="wallet-choice-icon" src={wallet.icon} />
                ) : (
                  <span aria-hidden="true" className="wallet-choice-icon is-monogram">
                    {wallet.name.slice(0, 1)}
                  </span>
                )}
                <span className="wallet-choice-name">{wallet.name}</span>
              </button>
            </li>
          ))}
        </ul>

        <p className="label onboarding-note">
          Solo aparecen las wallets instaladas en este navegador que firman mensajes en
          Solana. Si falta la tuya, ábrela una vez y vuelve a intentarlo.
        </p>

        <button type="button" className="segment" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </dialog>
  );
}
