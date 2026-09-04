# Copy: Spanish sentences, English terms

The site is in Spanish. Its **vocabulary is not**, and pretending otherwise produced copy that
no reader of this product would write: `cartera` for a wallet, `operar` for a trade, `en vivo`
for a live feed. The Spanish-speaking crypto community says wallet, trade, live. Translating a
term the audience already uses in English does not make the site more Spanish; it makes it read
like a translation.

Owner's decision, 2026-09-03. This file is the list the guard reads.

## The two rules

1. **Sentences, titles and labels are Spanish.** `Clasificación de KOLs`, `Wallets ocultas`,
   `Nadie cerró operaciones hoy todavía`, `Entrar al padrón`. Grammar, connectives and anything
   a reader parses as a phrase are Spanish, always.
2. **Terms of art stay in English**, from the list below, and are not conjugated into Spanish.
   A term is a noun the community uses as a name for the thing. It is not a licence to write an
   English sentence.

The two combine the way they do in the wild: *"el swap no llegó"*, *"tus wallets quedan
privadas"*, *"PnL del período"*.

## The list

`Trade` · `Cabals` · `Wallet` / `Wallets` · `PnL` · `Live` · `swap` · `token` · `holder` ·
`sniper` · `KOL` / `KOLs` · `DeFi` · `leaderboard`

Capitalisation follows use: `Trade` and `Cabals` are the names of pages and take a capital;
`swap`, `token`, `holder` and `sniper` are common nouns and do not, unless they open a
sentence. `PnL` and `DeFi` keep their own casing everywhere — they are not acronyms this
project gets to restyle.

**Plurals take the Spanish `-s`, never `-es`**: `wallets`, `tokens`, `KOLs`, `snipers`. Gender
is feminine for `wallet` (`la wallet`, `wallets ocultas`) and masculine for `swap`, `token`,
`holder` and `sniper`, which is what the community writes.

## `leaderboard` is on the list and is still not the name of the screen

The one term with a condition, and the condition is older than this file. `DESIGN.md`: *"The
ranked list is called `Clasificación`, everywhere a reader can see."* It had three names at once
— the nav said `Clasificación`, an onboarding CTA said `leaderboard` and five sentences said
*"el ranking"* — which reads as three screens rather than one.

So: `leaderboard` may appear as a **common noun for the kind of thing** (*"un leaderboard de
PnL realizado"*). It may not appear as **this screen's name**, and `ranking` may not appear at
all — it is neither Spanish nor the community's English. `copy.test.ts` looks for the article
in front of the word, which is what tells a name from a term.

## What the guard checks, and what it cannot

`copy.test.ts` enforces three things: no voseo anywhere a reader can see (the Rioplatense scan,
unchanged — neutral Spanish is a separate decision from this one), no `ranking`/`leaderboard`
standing in for `Clasificación`, and that **every term in the list above is spelled in the UI
the way this file spells it** — so `Pnl`, `Defi`, `wallett` or `cabales` fail.

It does **not** check that an English word is on the list before it ships. That check cannot be
written without a Spanish dictionary, and a list of banned English words is a list that is
always one word out of date. This file is the reference a reviewer reads; the guard is what
stops the list and the screen from drifting apart once a term is on it.
