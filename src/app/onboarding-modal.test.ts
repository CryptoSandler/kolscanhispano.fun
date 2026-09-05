import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { activeChains } from "@/lib/chain";
import { inventAddress, inventEvmAddress } from "@/lib/ids";
import { findDisallowedBase58, findDisallowedEvm } from "@/lib/hygiene";
import type { Chain } from "@/lib/chain";
import { OnboardingModal, type OnboardingWallet } from "./onboarding-modal";

/**
 * Rendered, not mounted, the way `kol-detail.test.ts` asserts its surface: the
 * questions here are about what the screen states and what it defaults to, and
 * both are answerable from the emitted HTML.
 */
/**
 * `available` used to be optional here because the component defaulted it to
 * `activeChains()`. That default was the hydration bug — it read `process.env`
 * inside a client component — so the prop is required now and the tests that
 * did not care pass the live list explicitly.
 */
function render(wallets: OnboardingWallet[], available: readonly Chain[] = activeChains()): string {
  return renderToStaticMarkup(createElement(OnboardingModal, { wallets, available }));
}

const solana: OnboardingWallet = { id: "w-1", chain: "solana", address: inventAddress() };
const ethereum: OnboardingWallet = { id: "w-2", chain: "ethereum", address: inventEvmAddress() };
const bnb: OnboardingWallet = { id: "w-3", chain: "bnb", address: inventEvmAddress() };

describe("¡Casi listo!", () => {
  it("names itself and the CTA in neutral Spanish", () => {
    const html = render([solana]);
    expect(html).toContain("¡Casi listo!");
    // The button names its destination, and the destination is titled
    // "Clasificación" (`src/app/leaderboard/page.tsx`). It said "Entrar al
    // leaderboard" until reading test-results/capturas/onboarding-*.png put
    // three names for one screen side by side: the nav's "Clasificación",
    // this screen's own body copy ("no aparece en el ranking"), and an
    // English noun in the one control that navigates there.
    expect(html).toContain("Entrar a la clasificación");
    // Neutral, not Rioplatense (CLAUDE.md): `puedes`, never `podés`.
    expect(html).not.toContain("podés");
    expect(html).not.toContain("Podés");
    expect(html).not.toContain("tenés");
  });

  it("lists every connected wallet with its chain badge", () => {
    const html = render([solana, ethereum, bnb], ["solana", "ethereum", "bnb"]);
    expect(html.match(/class="row-wallet"/g)).toHaveLength(3);
    expect(html).toContain("Solana");
    expect(html).toContain("Ethereum");
    expect(html).toContain("BNB Chain");
  });

  /**
   * The default, asserted on the markup rather than on the state that produced
   * it. `checked` on the private radio of every row is the thing a reader
   * actually sees, and it is the one property of this screen that cannot be
   * got wrong safely: a published address does not come back.
   */
  it("selects Privada on every row, and Pública on none", () => {
    const html = render([solana, ethereum, bnb]);

    // Whole tags, then two `includes`: React does not fix the order it emits
    // attributes in, and a regex that assumed one was green for the wrong
    // reason -- it matched nothing, and `[]` has the length it was asked for
    // only when that length is zero.
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(6);
    const checked = radios.filter((tag) => tag.includes("checked"));
    expect(checked).toHaveLength(3);
    for (const tag of checked) expect(tag).toContain('value="privada"');
  });

  it("offers both words per row, so neither state has to be inferred", () => {
    const html = render([solana, ethereum]);
    expect(html.match(/Pública/g)).toHaveLength(2);
    expect(html.match(/Privada</g)).toHaveLength(2);
  });

  it("gives each wallet's radios their own name, so one row cannot move another", () => {
    const html = render([solana, ethereum]);
    expect(html).toContain('name="visibilidad-w-1"');
    expect(html).toContain('name="visibilidad-w-2"');
  });

  /**
   * `DECISIONES.md`: the ranking sums every wallet, public and private, because
   * *"si el ranking dependiera de cuáles son públicas, el opt-in dejaría de ser
   * una decisión sobre privacidad y pasaría a ser una sobre el puesto."*
   *
   * So the screen must not let a reader believe publishing improves their
   * position. This asserts the sentence that says so, because it is the one
   * piece of copy on this screen that can mislead somebody into an irreversible
   * choice.
   */
  it("says what publishing changes, and what it does not", () => {
    const html = render([solana]);
    expect(html).toContain("suma todas tus");
    expect(html).toContain("no se puede despublicar");
  });

  it("says the profile is not on the ranking until the tweet is approved", () => {
    // The friction DECISIONES accepted, answered in the copy rather than by
    // loosening the gate.
    const html = render([solana]);
    expect(html).toContain("código de verificación");
    expect(html).toContain("no aparece en la clasificación");
  });

  it("names the three forms the handle field accepts", () => {
    const html = render([solana]);
    expect(html).toContain("tu usuario, tu usuario con @, o pegar el enlace");
  });

  it("starts with the CTA disabled, because no handle has been given yet", () => {
    expect(render([solana])).toContain("disabled");
  });

  /**
   * The address shown is the owner's own and is truncated, which is what makes
   * two rows distinguishable. It is deliberately *not* a public surface — but
   * the truncation is still asserted, because a full address rendered here
   * would be one paste away from a screenshot.
   */
  it("truncates the address rather than printing it whole", () => {
    const html = render([solana, ethereum]);
    expect(html).not.toContain(solana.address);
    expect(html).not.toContain(ethereum.address);
    expect(html).toContain(`${solana.address.slice(0, 6)}…${solana.address.slice(-4)}`);

    // And the truncation is short enough that neither repository scanner sees
    // an identifier in it, which is the same bar `hygiene.ts` sets.
    expect(findDisallowedBase58(html)).toEqual([]);
    expect(findDisallowedEvm(html)).toEqual([]);
  });

});

/**
 * `docs/multichain.md` §6, on this screen: a chain stays behind its ingestion
 * flag until that flag is on, and the screen offers only what it can index.
 */
describe("only the chains with live ingestion", () => {
  it("names the chains today's environment actually offers", () => {
    /*
      Asserted against the real default rather than a list passed in, and it
      **changed on 2026-09-04**: `CHAIN_ROBINHOOD_INGESTION=on` since the
      registration batch, so the sentence names two chains where it named one.

      Y **tres desde el 2026-09-05**, cuando se encendió BNB. La mitad de este
      caso que no se mueve es la otra: la cadena que sigue apagada no se nombra,
      porque nombrarla prometería una fecha que nadie tiene.
    */
    // `activeChains()` explicitly: this case is about what the live flags say,
    // and it used to lean on a default that has been removed because reading
    // the environment inside a client component was the hydration bug.
    const html = renderToStaticMarkup(
      createElement(OnboardingModal, { wallets: [solana], available: activeChains() }),
    );
    expect(html).toContain("Por ahora indexamos Solana, Robinhood y BNB Chain.");
    // La única que queda apagada. `BNB Chain` salió de esta lista el día que se
    // encendió — dejarlo habría convertido el caso en una contradicción consigo
    // mismo, porque la frase de arriba ya la nombra.
    expect(html).not.toContain("Ethereum");
  });

  it("promises the profile rather than a second registration", () => {
    // The sentence that keeps the limit from reading as a dead end: a chain
    // that turns on is offered to the KOLs who already exist.
    const html = render([solana]);
    expect(html).toContain("te la ofrecemos desde tu perfil");
    expect(html).toContain("no hace falta que vuelvas a registrarte");
  });

  it("names every active chain, in Spanish, when more than one is on", () => {
    // `Intl.ListFormat`: Spanish puts no comma before the conjunction, and a
    // hand-rolled join would have to learn that.
    expect(render([solana], ["solana", "bnb"])).toContain("indexamos Solana y BNB Chain.");
    expect(render([solana], ["solana", "bnb", "ethereum"])).toContain(
      "indexamos Solana, BNB Chain y Ethereum.",
    );
  });

  /**
   * The defensive half. A wallet on a chain that is not indexed cannot be
   * connected through this screen — but one could survive a chain being turned
   * back off, and the wrong answer then is a switch that looks live.
   *
   * It is disabled rather than hidden: it is the person's own wallet, and
   * removing it from the list would be the screen quietly losing something they
   * connected.
   */
  it("disables the switch on a wallet whose chain is not indexed", () => {
    const html = render([solana, ethereum], ["solana"]);
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(4);

    const disabled = radios.filter((tag) => tag.includes("disabled"));
    expect(disabled).toHaveLength(2);
    for (const tag of disabled) expect(tag).toContain("visibilidad-w-2");

    // And the row is still there: the wallet is not hidden.
    expect(html.match(/class="row-wallet"/g)).toHaveLength(2);
  });

  it("leaves every switch live when every wallet's chain is indexed", () => {
    const html = render([solana, ethereum], ["solana", "ethereum"]);
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios.filter((tag) => tag.includes("disabled"))).toHaveLength(0);
  });
});

describe("¡Casi listo!, the rest", () => {
  it("renders nothing but the two sections when there are no wallets yet", () => {
    // Not an error state: a reader can reach this screen having proved nothing
    // if they backed out, and an empty list plus a disabled CTA says so.
    const html = render([]);
    expect(html).toContain("¡Casi listo!");
    expect(html.match(/class="row-wallet"/g)).toBeNull();
  });
});
