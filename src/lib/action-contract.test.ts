import { describe, expect, it } from "vitest";
import { ACTION_REFUSALS, type ActionRefusal } from "./cabal-actions";
import { PROOF_ACTIONS, type ProofAction } from "./wallet-proof";

/**
 * **The contract for every signed action, as a table.**
 *
 * One row per action per precondition, and the word it refuses with. The table
 * is prose that fails: it is checked to cover **every** action in
 * `PROOF_ACTIONS`, and every refusal it names is checked against
 * `ACTION_REFUSALS`, so neither a new action nor a renamed refusal can leave it
 * quietly stale.
 *
 * What it is not: a substitute for the behavioural tests. Those live beside each
 * handler and actually drive it. This is the catalogue — the thing to read when
 * asking "what does this refuse, and why", and the thing that fails when an
 * action is added without anybody deciding the answer.
 */

type Contract = {
  action: ProofAction;
  /** Who may do it at all, in one phrase. */
  who: string;
  rules: { precondition: string; refusal: ActionRefusal }[];
};

/**
 * Five preconditions are shared by all fourteen, because they are the gate
 * rather than the rule (`signed-action.ts`). Listing them once per action would
 * be fourteen copies of the same four rows.
 */
const GATE: Contract["rules"] = [
  { precondition: "the nonce was never issued", refusal: "bad_proof" },
  { precondition: "the nonce belongs to another wallet", refusal: "bad_proof" },
  { precondition: "the nonce was issued for another action", refusal: "bad_proof" },
  { precondition: "the nonce was issued for another subject", refusal: "bad_proof" },
  { precondition: "the signature does not verify", refusal: "bad_proof" },
  { precondition: "the nonce was already spent", refusal: "bad_proof" },
  { precondition: "the signing wallet is not active", refusal: "unknown_wallet" },
  { precondition: "the signer's KOL is not approved", refusal: "unknown_wallet" },
];

const CONTRACT: Contract[] = [
  {
    action: "alta de perfil",
    who: "anybody registering",
    rules: [{ precondition: "handled by /api/registro, not the cabal gate", refusal: "bad_input" }],
  },
  {
    action: "agregar wallet",
    who: "anybody registering",
    rules: [{ precondition: "handled by /api/registro, not the cabal gate", refusal: "bad_input" }],
  },
  {
    action: "crear cabal",
    who: "any approved KOL with no cabal",
    rules: [
      { precondition: "the tag is not three or four capitals", refusal: "bad_input" },
      { precondition: "the colour is outside the measured palette", refusal: "bad_input" },
      { precondition: "the name is blank", refusal: "bad_input" },
      { precondition: "the signer already belongs to a cabal", refusal: "already_in_cabal" },
      { precondition: "another cabal still holds the tag", refusal: "tag_taken" },
    ],
  },
  {
    action: "pedir entrar al cabal",
    who: "any approved KOL with no cabal",
    rules: [
      { precondition: "the subject is not a tag", refusal: "bad_input" },
      { precondition: "the signer already belongs to a cabal", refusal: "already_in_cabal" },
      { precondition: "no cabal holds that tag, or it dissolved", refusal: "not_found" },
      { precondition: "a live request to that cabal exists", refusal: "already_requested" },
    ],
  },
  {
    action: "aceptar solicitud",
    who: "leader or co-leader",
    rules: [
      { precondition: "the subject is not a handle", refusal: "bad_input" },
      { precondition: "the signer leads nothing", refusal: "not_leader" },
      { precondition: "no such KOL, or no pending request from them", refusal: "not_found" },
      { precondition: "the applicant joined another cabal meanwhile", refusal: "already_in_cabal" },
    ],
  },
  {
    action: "rechazar solicitud",
    who: "leader or co-leader",
    rules: [
      { precondition: "the subject is not a handle", refusal: "bad_input" },
      { precondition: "the signer leads nothing", refusal: "not_leader" },
      { precondition: "no such KOL, or no pending request from them", refusal: "not_found" },
    ],
  },
  {
    action: "expulsar del cabal",
    who: "leader or co-leader",
    rules: [
      { precondition: "the subject is not a handle", refusal: "bad_input" },
      { precondition: "the signer expels themselves", refusal: "bad_input" },
      { precondition: "the signer leads nothing", refusal: "not_leader" },
      { precondition: "no such approved KOL", refusal: "not_found" },
      { precondition: "the target is in another cabal", refusal: "not_a_member" },
      { precondition: "the target is the leader", refusal: "cannot_expel_leader" },
    ],
  },
  {
    action: "transferir el cabal",
    who: "the leader only",
    rules: [
      { precondition: "the subject is not a handle", refusal: "bad_input" },
      { precondition: "the heir is the signer", refusal: "bad_input" },
      { precondition: "the signer is a co-leader, not the leader", refusal: "not_leader" },
      { precondition: "no such approved KOL", refusal: "not_found" },
      { precondition: "the heir is not in this cabal", refusal: "not_a_member" },
    ],
  },
  {
    action: "nombrar co-líder",
    who: "the leader only",
    rules: [
      { precondition: "the subject is not a handle", refusal: "bad_input" },
      { precondition: "the nominee is the leader", refusal: "bad_input" },
      { precondition: "the signer is a co-leader, not the leader", refusal: "not_leader" },
      { precondition: "no such approved KOL", refusal: "not_found" },
      { precondition: "the nominee is not in this cabal", refusal: "not_a_member" },
      { precondition: "they are already a deputy", refusal: "already_co_leader" },
      { precondition: "both slots are taken", refusal: "no_slot" },
    ],
  },
  {
    action: "revocar co-líder",
    who: "the leader only",
    rules: [
      { precondition: "the subject is not a handle", refusal: "bad_input" },
      { precondition: "the signer is a co-leader, not the leader", refusal: "not_leader" },
      { precondition: "no such approved KOL", refusal: "not_found" },
      { precondition: "they are not a deputy", refusal: "not_a_co_leader" },
    ],
  },
  {
    action: "ver solicitudes",
    who: "leader or co-leader",
    rules: [
      { precondition: "the subject is not a tag", refusal: "bad_input" },
      { precondition: "the signer leads nothing", refusal: "not_leader" },
      { precondition: "the tag is not the cabal they lead", refusal: "not_leader" },
    ],
  },
  {
    action: "ver mi solicitud",
    who: "the applicant, about their own",
    rules: [
      { precondition: "the subject is not a tag", refusal: "bad_input" },
      { precondition: "no such cabal, or they never asked", refusal: "not_found" },
    ],
  },
  {
    action: "reclamar cabal",
    who: "the nominated KOL only",
    rules: [
      { precondition: "the subject is not a tag", refusal: "bad_input" },
      { precondition: "no cabal holds that tag", refusal: "not_found" },
      { precondition: "no pending nomination naming this signer", refusal: "not_found" },
      { precondition: "already claimed", refusal: "not_found" },
      { precondition: "the nomination's seven days ran out", refusal: "expired" },
      { precondition: "the cabal is no longer an orphan", refusal: "not_orphaned" },
      { precondition: "the signer belongs to another cabal", refusal: "already_in_cabal" },
    ],
  },
  {
    action: "retirar wallet",
    who: "any approved KOL, about the wallet that signs",
    rules: [
      { precondition: "the request carries a subject", refusal: "bad_input" },
      { precondition: "the wallet is already withdrawn", refusal: "unknown_wallet" },
    ],
  },
];

describe("the contract table", () => {
  it("covers every action in PROOF_ACTIONS, and invents none", () => {
    // The one that fails when somebody adds an action and does not decide what
    // it refuses. `DECISIONES.md` already makes adding one two changes; this
    // makes it three, and the third is the thinking.
    expect(CONTRACT.map((row) => row.action).sort()).toEqual([...PROOF_ACTIONS].sort());
  });

  it("names only refusals that exist", () => {
    const known = new Set<string>(ACTION_REFUSALS);
    const invented = CONTRACT.flatMap((row) =>
      [...row.rules, ...GATE]
        .filter((rule) => !known.has(rule.refusal))
        .map((rule) => `${row.action}: ${rule.refusal}`),
    );
    expect(invented).toEqual([]);
  });

  it("leaves no refusal undocumented", () => {
    const used = new Set(CONTRACT.flatMap((row) => row.rules.map((r) => r.refusal)));
    for (const rule of GATE) used.add(rule.refusal);
    // A word the code can answer but the table never explains is a refusal
    // nobody decided the meaning of.
    expect([...ACTION_REFUSALS].filter((refusal) => !used.has(refusal))).toEqual([]);
  });

  it("gives every action at least one rule of its own beyond the gate", () => {
    expect(CONTRACT.filter((row) => row.rules.length === 0).map((r) => r.action)).toEqual([]);
  });
});
