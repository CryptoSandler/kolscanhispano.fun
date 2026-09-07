# Security model

This document describes what kolscanhispano.fun protects, how, and — importantly — what it does not
protect. The implementation lives in `docs/spec-v1.md` §7 (what we publish) and §8 (what an attacker
gets from our storage).

## The asset

The product indexes public on-chain activity, which is not secret. The sensitive asset is the
**mapping between a public persona and a set of Solana addresses**.

That mapping exists because the product cannot work without it: to show "this KOL bought this token"
we must know which addresses belong to which KOL. It is held deliberately, not by oversight, and the
controls below exist to keep it from being cheap to steal or easy to leak by accident.

Most listed KOLs choose `hide_wallets` (the default). For them, publishing the address would be a
deanonymisation they did not consent to.

## What each layer protects against

| Layer | Protects against | Does not protect against |
|---|---|---|
| **AES-256-GCM at rest** on addresses, signatures and raw payloads | A stolen database dump, a leaked connection string, a backup on someone's laptop, a Neon-side incident — none of these yield addresses | Anything with access to the application environment |
| **HMAC-SHA-256 blind index**, key held separately from the encryption key | Offline guessing: an attacker with the dump cannot test a suspected address against the index, and cannot build a rainbow table over the ~10⁸ addresses that matter | An attacker who holds the HMAC key |
| **Signatures encrypted too** | The obvious bypass: a signature pasted into any explorer reveals its signer, so encrypting only the address column would protect nothing | The public chain itself — see "inherent exposure" |
| **Keys in Vercel env, never in Neon** | A compromise of the database provider being sufficient on its own | A compromise of the application host |
| **No addresses in the repo**, enforced by a test | Accidental disclosure through fixtures, seeds, error messages, logs, or a public git history that can never be rewritten | Deliberate disclosure by someone with access |
| **Masked admin views, step-up reveal, audited, no bulk export** | A leaked admin session becoming a mass deanonymisation; quiet browsing of the mapping; a well-meaning "export to CSV" that ends up in a Slack thread | An admin who decides to reveal rows one at a time and copy them down |
| **Serializer-level omission** for hidden KOLs (§7) | The whole class of bugs where an address is sent to the browser and hidden in CSS, or leaks through an avatar URL, an ordering, or a cursor | — |
| **Third-party split**: Helius gets addresses with no names; DexScreener gets mints; unavatar gets handles | Any single vendor, or a breach of one, holding both halves of the link | Correlation across vendors by someone who breaches several |

## What this does not protect against

Stated plainly, because a control that oversells itself is worse than none:

- **A compromised server with environment access defeats everything above.** The keys are in the
  environment, the decryption path is in the code, and the mapping falls out. Encryption at rest
  raises the cost of a database-only compromise; it is not a defence against an attacker who is
  already running our code.
- **A malicious or coerced administrator.** Reveals are logged, not prevented. The audit log is
  evidence after the fact, not a control.

  **And the two things that protect the audit log are tripwires, not guarantees.** `audit_log` is
  append-only by trigger (`migrations/018`), and every row commits to the hash of the one before
  it. Both stop the accident and the casual edit — a console session, a migration that "fixes" a
  row, a handler that meant to update — and neither stops the operator: the same owner the trigger
  refuses can `DROP TRIGGER` and then delete, and whoever can write rows can recompute the chain
  from the point they changed. What survives an operator who decides to rewrite the account is the
  **signature** stored beside each entry (`audit_signature`): it was produced by a KOL's wallet
  over a single-use nonce, so nobody with database access can forge one or move it to a different
  action. That is the only part of this account that does not rest on trusting us — and it covers
  only the entries a KOL signed, never the admin's own, which are authorised by a token we hold.

  **The chain covers both principals; the signature covers one.** The admin's `approve` and a
  leader's `transferir el cabal` go into the same table through the same writer, so there is no
  seam between two accounts where a row could go missing without breaking a link. What tells them
  apart is what authorised the row — a nonce and a signature, or the admin token — and an entry
  with no signature is exactly that and says so by the row's absence rather than by a claim. So an
  administrator's own actions are guarded only by the tripwires, which is the honest reading of the
  threat this bullet names: we are not able to prove our own good behaviour to you.
- **Inherent chain exposure.** Amount, mint and timestamp are enough to locate a transaction in any
  public explorer, and from there the signer. "Wallets ocultas" means *we do not publish the
  address*. It is not anonymity, and both the KOL page and the terms say so in those words. Anyone
  who needs real unlinkability should not register.
- **Traffic and timing.** We do not defend against an observer correlating our feed's publication
  times with on-chain activity.
- **Vercel and Neon themselves.** We trust our hosts. Splitting the keys across providers means
  neither one alone holds the mapping, which is the practical benefit of that split — but a
  compromise at the application host is game over.

## Reporting

Security issues: open a GitHub issue on `CryptoSandler/kolscanhispano.fun` marked `security`, without
technical detail, and ask for a private channel.

## Removal

Any listed KOL can ask to be removed and it will be honoured. Removal is the admin *suspend*
operation: the profile disappears from every public surface, including already-closed leaderboards,
indexing stops, and their addresses leave the Helius webhook. The rows and their audit trail stay in
the database; they are not published anywhere.


# Qué protege cada capa, y qué no — 2026-09-06

Escrito porque un documento de seguridad que sólo enumera defensas es un
documento que se lee como una promesa. Cada capa dice acá **contra quién**
sirve, y la última sección dice contra quién no sirve ninguna.

## Las capas que hay hoy

| Capa | Protege contra | **No** protege contra |
|---|---|---|
| `address_enc`: AES-GCM con AAD ligada al id de la fila | Un dump de la base, una réplica, un backup de Neon filtrado — la clave vive en Vercel, no en Postgres | Cualquiera que tenga la app corriendo o sus variables de entorno |
| `WALLET_HMAC_KEY` distinta de `WALLET_ENC_KEY` | Que quien obtenga una de las dos pueda hacer el trabajo de la otra: el índice ciego no se puede construir con la clave de cifrado ni al revés | Que se filtren las dos, que viven en el mismo lugar |
| Índice ciego (HMAC) en vez de la dirección en claro | Buscar por dirección sin descifrar; y que un `WHERE address = …` deje la dirección en un log de consultas | Un atacante que ya tiene la clave del HMAC y una lista de direcciones candidatas: puede confirmar cuáles están |
| `public-wallets.ts` como único módulo que descifra para superficie pública | Que una ruta nueva publique una dirección por descuido | Un cambio deliberado en ese módulo |
| `is_public` por wallet | Que se publique una dirección que su dueño no eligió publicar | Nada, si el dueño la publica |
| `address-invariant.test.ts`: lee el HTML servido | Que de una wallet privada se escape algo — ni la dirección ni sus primeros caracteres. Una dirección truncada sigue siendo buscable en un explorador, así que no se trunca: no aparece | Una superficie nueva que el test todavía no lea |
| Sin operaciones individuales en superficie pública (2026-09-06) | Reconstruir una transacción desde el sitio y llegar a la wallet por el explorador | Que alguien mire la cadena directamente: las direcciones públicas son públicas |
| `no-money-path.test.ts` | Que una API que construye o manda transacciones se vuelva importable | Un atacante que ya ejecuta código en el proceso |
| Rate limit por IP y bucket | Barrido anónimo de las rutas públicas | Un atacante distribuido, o uno con el token de admin |
| `ADMIN_TOKEN` comparado en tiempo constante | Adivinar el token midiendo tiempos | Un token filtrado: no tiene expiración |

## Lo que ninguna capa protege, y se dice

**El operador con la clave y la base puede descifrar todo.** Nosotros. No hay
nada acá que lo impida, ninguna de estas capas lo intenta, y un documento que
sugiriera lo contrario sería peor que no tener documento.

Lo que este sistema protege es **el vínculo entre una dirección y un handle de
X** —que es lo que tiene valor, porque las direcciones ya son públicas en la
cadena— y lo protege **contra terceros**: un dump sin las variables de entorno,
una superficie pública, un backup filtrado, un barrido anónimo.

Las otras cuatro cosas que no cubre, dichas en voz alta:

1. **Vercel, o quien tenga sus variables de entorno**, tiene la clave.
2. **Ejecución de código en el proceso** (RCE, una dependencia comprometida) lee
   lo que el proceso lee, que es todo.
3. **`ADMIN_TOKEN` no expira.** Un token filtrado sirve hasta que alguien lo
   rota a mano.
4. **`public-surfaces.test.ts` es un escaneo de código**, no una prueba de
   comportamiento: atrapa la regresión distraída, no a alguien decidido.

La ronda del 2026-09-06 (`docs/round-hardening-wallets.md`) discute qué de esto
vale la pena cerrar y en qué orden, y por qué tres de las siete capas propuestas
no cambian ninguna de estas cuatro filas.
