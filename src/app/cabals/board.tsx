import { type PublicCabal } from "@/lib/cabals";
import { amountDirection, formatSignedSol, formatSignedUsd } from "@/lib/format";
import { Avatar } from "../avatar";

/**
 * `/cabals`'s two states, and the surface between them: a podium of three
 * cards over a list of everyone else (`docs/clone-map.md` §6).
 *
 * It is its own component rather than part of the page for the reason
 * `LeaderboardTable` is: the page reads the database, and both states have to
 * be renderable from a fixture — `empty-states.test.ts` asserts the empty one
 * against DESIGN.md's own words, on real markup.
 *
 * **What is theirs and what is ours.** The arrangement, the hierarchy and the
 * labels are theirs, translated. Three things are not:
 *
 * - **No logo is fetched.** `cabal.logo_url` holds a URL somebody typed, and
 *   rendering it would put a third party in every visitor's request path — the
 *   objection spec §6 makes to hotlinking a KOL's photo, which does not stop
 *   being true because the picture is of a group. The monogram `/api/avatar`
 *   already falls back to is drawn here directly (exception a).
 * - **No `𝕏` per cabal.** They print one; `cabal` has no handle column, and
 *   inventing the link would mean guessing a URL.
 * - **No status dot on the logo.** It marks something their product knows and
 *   ours does not, and a dot that is always the same colour is decoration
 *   pretending to be information.
 */
export function CabalsBoard({ entries }: { entries: PublicCabal[] }) {
  /*
    DESIGN.md, "Every surface has two states", and the same discriminator the
    leaderboard uses: a board where **nothing closed anywhere** is a board that
    measures nothing, and three podium cards reading `0,00 SOL` would be the
    cabal version of kolscan.io's fifty rows of `+0.00 Sol`. A cabal that closed
    nothing while another closed something still shows, at zero — that is a real
    comparison, and spec §2's roster argument applies to it unchanged.
  */
  if (entries.every((entry) => entry.closed === 0)) {
    return (
      <div className="state-empty">
        <p className="state-empty-lead">Todavía no hay cabals con posiciones cerradas.</p>
        <p className="state-empty-note">
          Aquí van los grupos del padrón, ordenados por PnL realizado del período, en cuanto sus
          miembros cierren su primera posición.
        </p>
      </div>
    );
  }

  return (
    <>
      <Podium entries={entries.slice(0, 3)} />
      {entries.length > 3 && (
        <>
          <h2 className="label section-label">Otros cabals</h2>
          <ul className="board">
            {entries.slice(3).map((entry) => (
              <li key={entry.tag} className="row-cabal">
                <span className="rank-cell">
                  <span className="num rank-num">{entry.rank}</span>
                </span>
                <span className="identity">
                  <Avatar name={entry.name} src="" size={36} />
                  <span className="identity-lines">
                    <span className="name">{entry.name}</span>
                    <ReassignedNote at={entry.reassignedAt} by={entry.reassignedTo} />
          <DissolvedNote at={entry.dissolvedAt} />
                    <span className="identity-second">
                      <span className="handle">({entry.tag})</span>
                    </span>
                  </span>
                </span>
                <span className="num members">{members(entry.members)}</span>
                <span className={`num-lg pnl ${amountDirection(entry.realizedSol)}`}>
                  {formatSignedSol(entry.realizedSol)}
                </span>
                <span className="num secondary">({formatSignedUsd(entry.realizedUsd)})</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** `1 miembro` / `4 miembros`. One string, one place, `es-ES`. */
function members(count: number): string {
  return count === 1 ? "1 miembro" : `${count} miembros`;
}

/**
 * The three cards, in the order the eye reads a podium rather than the order
 * the ranking produces: **second, first, third**, with the first taller.
 *
 * A ranking with one or two cabals in it renders one or two cards. The order is
 * built by filtering the arrangement against what exists rather than by
 * branching on the count, so a missing rank is an absent card and never a gap
 * the layout has to hold open.
 */
/**
 * "Reasignado por admin, reclamado por @x el <fecha>".
 *
 * **Both halves are the point.** `docs/round-reasignacion.md`: an orphaned cabal
 * is repaired in two acts by two people — the operator nominates, and the
 * nominee claims it with their own signature. Naming only the operator would
 * hide who benefited; naming only the claimer would read like an ordinary
 * transfer. A reader is owed the difference between a group that changed hands
 * by an act of its leader and one that changed hands because the operator
 * offered it and somebody signed for it.
 *
 * The date is the **claim**, not the nomination: until somebody signed, nothing
 * had happened.
 *
 * **The reason is not here.** It is mandatory and it lives in `audit_log`,
 * because a reason describes somebody's circumstances — a lost wallet, a
 * suspension — and publishing it would turn a repair into a punishment.
 *
 * It renders nothing at all for the cabals nobody ever had to repair, which is
 * almost every one: the rows `DESIGN.md` measures against the mould keep exactly
 * the geometry they were measured at, and only the exceptional row grows a line.
 */
/**
 * "Disuelto el <fecha>", when its leader ended it.
 *
 * A dissolved cabal keeps everything except being live, and its tag for thirty
 * more days — so a reader seeing it beside the live ones is owed the difference.
 * Nothing here says why: ending a group is the leader's business, and the
 * product never asked them for a reason.
 */
function DissolvedNote({ at }: { at: string | null }) {
  if (at === null) return null;
  return (
    <span className="hidden-wallets">
      Disuelto el <time dateTime={at}>{new Date(at).toLocaleDateString("es")}</time>
    </span>
  );
}

function ReassignedNote({ at, by }: { at: string | null; by: string | null }) {
  if (at === null) return null;
  return (
    <span className="hidden-wallets">
      Reasignado por admin, reclamado por {by === null ? "su líder" : `@${by}`} el{" "}
      <time dateTime={at}>{new Date(at).toLocaleDateString("es")}</time>
    </span>
  );
}

function Podium({ entries }: { entries: PublicCabal[] }) {
  return (
    <ol className="podium">
      {podiumEntries(entries).map((entry) => (
        <li key={entry.tag} className={`podium-card is-podium-${entry.rank}`}>
          <span className="podium-medal" aria-hidden="true">
            {PODIUM_MEDALS[entry.rank as 1 | 2 | 3]}
          </span>
          <Avatar name={entry.name} src="" size={64} />
          <span className="podium-name">{entry.name}</span>
          <ReassignedNote at={entry.reassignedAt} by={entry.reassignedTo} />
          <DissolvedNote at={entry.dissolvedAt} />
          <span className="podium-tag label">({entry.tag})</span>
          {/*
            **One figure on a podium card, not two.**

            Measured against the mould on 2026-09-05: their cabals podium reads
            `🏆 El Cartel (ELC) +R$2.172.365 3 membros` — a single amount and the
            member count. Ours carried the SOL total *and* a smaller
            parenthesised USD under the medal, which is a second figure they do
            not have. The list rows below still show both, as theirs do; it is
            the card that is one.
          */}
          <span className={`num-lg podium-pnl ${amountDirection(entry.realizedSol)}`}>
            {formatSignedSol(entry.realizedSol)}
          </span>
          <span className="label podium-members">{members(entry.members)}</span>
        </li>
      ))}
    </ol>
  );
}

/** The same glyphs the ranking's podium carries, so one product has one podium. */
const PODIUM_MEDALS = { 1: "🏆", 2: "🥈", 3: "🥉" } as const;

function podiumEntries(entries: PublicCabal[]): PublicCabal[] {
  return [2, 1, 3]
    .map((rank) => entries.find((entry) => entry.rank === rank))
    .filter((entry): entry is PublicCabal => entry !== undefined);
}
