# kolscanhispano.fun

Every message you send to the user starts with the line `[kolscanhispano.fun]` on its own, before anything else, so the user can tell which project is talking when several Claude Code sessions run in parallel.

## Project

kolscan.io for the Spanish-speaking community (Spain + Latam), the way kolscanbrasil.io is for Brazil. The domain is the brand.

## Conventions

- Site UI copy: neutral Spanish (not Rioplatense).
- Code, comments, commits, and docs: English.
- No-doxx: no real names, no personal data, no author identity beyond the GitHub account `CryptoSandler`.

## Stack

Next.js 16 (App Router, Turbopack) + Postgres (Neon) + Vercel. Next 16 has breaking changes against
what most models were trained on — APIs, conventions and file structure all differ. Read the
relevant guide in `node_modules/next/dist/docs/` before writing App Router code, and heed its
deprecation notices. `next.config.ts` sets `agentRules: false`, which is why this file is not
maintaining that pointer itself: `next dev` otherwise rewrites this file on every run.
