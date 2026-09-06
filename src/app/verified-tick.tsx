/**
 * **La tilde de verificado**, sólo si el handle se probó por el flujo de
 * `/registro`: tweet con el código más firma de la wallet (`migrations/014`,
 * `kol.tweet_verified_at`).
 *
 * Los KOL que el admin sembró a mano **no la llevan** — se agregaron desde un
 * cruce de trackers, nadie probó que la cuenta sea suya, y una tilde ahí diría
 * algo que no pasó. No es lo mismo que estar aprobado: un admin puede aprobar
 * un handle sin verificar, y la auditoría registra que lo hizo.
 *
 * Vive en su propio archivo porque sale en dos superficies —la fila y el
 * modal— y un SVG copiado en dos lados es un SVG que se corrige en uno.
 *
 * El `title` es para el mouse y el `sr-only` para quien no lo tiene: un
 * `title` solo no lo anuncia ningún lector de pantalla de forma confiable.
 */
export function VerifiedTick({ verified }: { verified: boolean }) {
  if (!verified) return null;
  return (
    <span className="verified-tick" title="Handle verificado por tweet firmado">
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
        <path
          d="M2.5 6.2l2.3 2.3 4.7-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="sr-only">Handle verificado por tweet firmado</span>
    </span>
  );
}
