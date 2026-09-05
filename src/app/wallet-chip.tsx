"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicWallet } from "@/lib/public-wallets";

/**
 * The address slot on a ranking row: published wallets, or `Wallets ocultas`.
 *
 * ## The invariant this renders, in one line
 *
 * **A wallet appears here only because its KOL opted it in.** `is_public` is
 * checked in `public-wallets.ts`, the only module that decrypts an address for a
 * public surface, and this component receives nothing else — it cannot show a
 * private wallet because it is never handed one.
 *
 * What is published is **six leading characters on the row** and **six plus four
 * in the panel** (`4PsfXF...bAhW`). The middle is never published in any form:
 * an address is recognisable from its ends and unfindable without its middle.
 *
 * ## The panel, and the bug it fixes
 *
 * `+N ▾` used to insert the extra addresses **inline, beside the chip**, which
 * pushed the identity line wider until the name was clipped — `prueba dos …`.
 * The mould does something else, and this now copies it: the row does not
 * change at all, and an indented panel opens **below** it with one line per
 * wallet. The card grows, the rows beneath move down, and the name is never
 * touched.
 */
export function WalletChip({ wallets }: { wallets: PublicWallet[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  /*
    Esc and click-outside, installed only while the panel is open.

    `mousedown` rather than `click`: the row itself opens the KOL modal on
    click, and a listener that waited for `click` would race it. `capture` so
    this runs before the row's own handler, which is what lets the panel close
    without the row deciding something happened to it.
  */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [open]);

  if (wallets.length === 0) return <span className="hidden-wallets">Wallets ocultas</span>;

  const [first, ...rest] = wallets;
  // Distinct families, not one badge per wallet: the mould shows `SOL EVM` for
  // somebody with three wallets across two namespaces.
  const families = [...new Set(wallets.map((w) => w.family))];

  return (
    /*
      **Chip and panel share one parent**, and that parent is the flex line the
      identity already is. `.identity-line` is `display: flex`, so the panel
      takes `flex: 0 0 100%` and wraps onto its own row underneath: the card
      grows, the rows below move down, and the name keeps its width.

      They cannot be two grid areas of the card — `leaderboard-table.tsx` is a
      **server** component and the open state has to live in a client one. One
      component holding both is what makes that work, and it is simpler than the
      alternative anyway.
    */
    <div className="wallet-cell" ref={root}>
      <span className="wallet-chip">
      <span className="num wallet-short">{first.short}</span>
      {rest.length > 0 && (
        <button
          type="button"
          className="wallet-more"
          aria-expanded={open}
          aria-controls="wallet-panel"
          onClick={(event) => {
            // The row opens the modal on click; this control is inside it and
            // must not.
            event.stopPropagation();
            setOpen((was) => !was);
          }}
        >
          +{rest.length}{" "}
          <span className={`wallet-caret${open ? " is-open" : ""}`} aria-hidden="true">
            ▾
          </span>
        </button>
      )}
        {families.map((family) => (
          <span key={family} className={`chain-badge is-${family.toLowerCase()}`}>
            {family}
          </span>
        ))}
      </span>
      {rest.length > 0 && (
        <span className="wallet-panel" id="wallet-panel" hidden={!open}>
          {wallets.map((wallet) => (
            <span key={`${wallet.chain}-${wallet.display}`} className="wallet-panel-row">
              <span className={`chain-badge is-${wallet.family.toLowerCase()}`}>
                {wallet.family}
              </span>
              <span className="num wallet-full">{wallet.display}</span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
