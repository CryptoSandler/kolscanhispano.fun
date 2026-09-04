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
/**
 * What the chooser needs from a wallet: a name to show and a chain to label it
 * with. Deliberately structural rather than a union of the two wallet types —
 * this component has no business knowing which handshake found a row.
 */
/** The chains a row may name, spelled for a reader. `chain.ts` is the source. */
const CHAIN_LABEL: Record<string, string> = {
  solana: "Solana",
  robinhood: "Robinhood",
  bnb: "BNB",
  ethereum: "Ethereum",
};

export type PickableWallet = { name: string; chain: string; icon?: string };

export function WalletPicker({
  wallets,
  onPick,
  onCancel,
}: {
  /**
   * **A row is a name and a chain, and nothing else.** It was
   * `readonly StandardWallet[]` while Solana was the only namespace; EIP-6963
   * wallets arrive through a different handshake and have no `features` map, so
   * the chooser stopped taking wallets and started taking rows. What it must
   * never take is anything it could *call* — it picks, the caller connects.
   */
  wallets: readonly PickableWallet[];
  onPick: (wallet: PickableWallet) => void;
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
            <li key={`${wallet.chain}:${wallet.name}`}>
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
                {/* The chain, because two namespaces now reach this list and a
                    reader with MetaMask and Phantom installed is choosing
                    between two different things, not two brands. Copied from
                    the mould's chain chip — `docs/copy.md` keeps the term in
                    English — and it carries no address, ever. */}
                <span className="wallet-choice-chain">{CHAIN_LABEL[wallet.chain] ?? wallet.chain}</span>
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
