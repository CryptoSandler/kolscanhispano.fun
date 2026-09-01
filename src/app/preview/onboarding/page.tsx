import { notFound } from "next/navigation";
import { inventAddress, inventEvmAddress } from "@/lib/ids";
import { OnboardingModal, type OnboardingWallet } from "../../onboarding-modal";

/**
 * A **design preview** of `¡Casi listo!`, and deliberately not `/registro`.
 *
 * The registration flow does not exist: `docs/wallet-proof.md` §1 closed the
 * round with "build the verifier, not the endpoints", and there is no claim
 * table, no session and no nonce endpoint. So there is nothing that could
 * populate this screen with real wallets, and a `/registro` that rendered
 * invented ones would be a page claiming to be a flow it is not.
 *
 * This path says what it is. It exists so the screen can be reviewed and
 * screenshotted before the flow behind it is built — the owner's gate needs to
 * see the design, and a component that only exists inside a test file cannot be
 * looked at.
 *
 * **Closed in production**, by `VERCEL_ENV` rather than by `NODE_ENV`: Vercel
 * builds a Preview deployment with `NODE_ENV=production`, so a `NODE_ENV` gate
 * would have closed exactly the deployment this page exists for. `notFound()`
 * rather than a redirect, so the path is indistinguishable from one that was
 * never routed.
 *
 * It is removed by the batch that builds `/registro` for real. Recorded here
 * rather than remembered, so it does not become a permanent second entrance.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Vista previa · ¡Casi listo!",
  // Not indexable, whatever `robots.ts` says: this is not product surface.
  robots: { index: false, follow: false },
};

/**
 * Invented on every request, never written down.
 *
 * `SECURITY.md` forbids a real address in the repository, and a fixed fake one
 * would still be a 32-character base58 literal in tracked source — which is
 * what `hygiene.ts` scans for and would refuse. `ids.ts` is the same generator
 * every fixture uses.
 */
function mockWallets(): OnboardingWallet[] {
  return [
    { id: "vista-1", chain: "solana", address: inventAddress() },
    { id: "vista-2", chain: "solana", address: inventAddress() },
    { id: "vista-3", chain: "ethereum", address: inventEvmAddress() },
    { id: "vista-4", chain: "bnb", address: inventEvmAddress() },
  ];
}

export default function OnboardingPreviewPage() {
  if (process.env.VERCEL_ENV === "production") notFound();

  return (
    <main className="page">
      <p className="label" style={{ marginBottom: "var(--stack)" }}>
        Vista previa de diseño. El registro todavía no existe.
      </p>
      <OnboardingModal wallets={mockWallets()} />
    </main>
  );
}
