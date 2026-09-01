/**
 * Shadow measurement of Helius's empty `userAccount` — plan v1, batch 2, task 8.
 *
 * **This is a script, not a test.** It is the only thing in this repository
 * permitted to make a live network call, and it spends real Helius credits.
 * It must never grow a `.test.ts` name or be reachable from `vitest run`: the
 * suite installs a network guard per test file precisely so that nothing there
 * can do what this file does on purpose.
 *
 *     npx tsx scripts/sombra-user-account.ts
 *
 * `parse-swap.ts` reads each token balance change's `userAccount` to decide
 * whose leg it is. Helius sometimes reports it as an empty string, and the
 * parser then either raises `MalformedPayloadError` (the change sits on an
 * account we can see is ours, or this wallet has a leg of its own elsewhere)
 * or treats the change as unattributable. Batch 1 chose that handling on a
 * six-transaction sample. This measures it against real volume.
 *
 * Nothing here changes the parser. It *imports* `evaluateSwap` and asks it
 * the question directly, rather than restating its rules, so the number
 * reported is the number the shipped parser produces. `evaluateSwap` is pure
 * — no `await`, no query — so calling it costs nothing and reaches no
 * database.
 *
 * **The key never reaches a log line.** It goes in the URL, so the URL is
 * never logged, never interpolated into a thrown message, and never included
 * in an error. `heliusAssetMetadata` in `src/lib/prices.ts` documents the same
 * trap: a `fetch` rejection's `message` or `cause` can carry the request URL,
 * and the URL carries the API key. On a request failure only the status code
 * is reported.
 *
 * **No address ever enters the repository.** Addresses come from
 * `HELIUS_SHADOW_ADDRESSES` and nowhere else — no default, no committed list
 * (spec §8.3). Raw payloads are cached under `fixtures/helius/`, which this
 * script refuses to write to unless git is already ignoring it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ONE } from "../src/lib/decimal";
import { MalformedPayloadError, evaluateSwap, type EnhancedTx } from "../src/lib/parse-swap";

const ENDPOINT = "https://mainnet.helius-rpc.com/v0/addresses";
const PAGE_LIMIT = 100;
const CACHE_DIR = join("fixtures", "helius");
/** Page cursor -> the signatures that page held, so a second run pages for free. */
const PAGE_INDEX = join(CACHE_DIR, "_pages.json");
const DEFAULT_MAX_REQUESTS = 50;
const CREDITS_PER_REQUEST = 100;

// ---------------------------------------------------------------- environment

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  // The message names the variable and nothing else: a value here can be an
  // API key or a real address.
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Strict: a non-numeric or non-positive `HELIUS_SHADOW_MAX_REQUESTS` is fatal.
 * Falling back to the default on a typo would spend the default's credits
 * while the operator believed they had asked for two.
 */
function maxRequests(): number {
  const raw = process.env.HELIUS_SHADOW_MAX_REQUESTS?.trim();
  if (!raw) return DEFAULT_MAX_REQUESTS;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new Error("HELIUS_SHADOW_MAX_REQUESTS must be a positive integer");
  }
  return Number(raw);
}

/**
 * These payloads carry real addresses and real signatures, and the signature
 * is in the filename. Ask git rather than trusting that someone remembered to
 * add the line.
 */
function assertCacheIgnored(): void {
  try {
    execFileSync("git", ["check-ignore", "-q", join(CACHE_DIR, "probe.json")]);
  } catch {
    throw new Error(`refusing to write: ${CACHE_DIR} is not git-ignored`);
  }
}

// --------------------------------------------------------- the budgeted client

class BudgetExhausted extends Error {}

/**
 * The single request site, and the only place the budget exists. It increments
 * *before* the request goes out and aborts the run when the next request would
 * exceed the cap, rather than returning a short page that later code would
 * mistake for exhausted history. A partial measurement reported as complete is
 * the failure mode this guards.
 *
 * Serial by construction, which is already inside the free plan's 10 RPS.
 */
class HeliusClient {
  requests = 0;
  constructor(
    private readonly apiKey: string,
    readonly cap: number,
  ) {}

  async page(address: string, before: string | null): Promise<unknown[]> {
    if (this.requests + 1 > this.cap) throw new BudgetExhausted();
    this.requests += 1;

    const url = new URL(`${ENDPOINT}/${address}/transactions`);
    url.searchParams.set("api-key", this.apiKey);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("type", "SWAP");
    if (before) url.searchParams.set("before", before);

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      // Never the caught error: its message or cause can carry the URL.
      throw new Error("helius: request failed");
    }
    if (!response.ok) throw new Error(`helius: non-OK response (${response.status})`);
    if (this.requests === 1) {
      // Header *names* only, once: the report needs to say whether credit
      // accounting is observable on the wire, and a value here could carry
      // something that should not be logged.
      console.log(`response header names: ${[...response.headers.keys()].join(", ")}`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("helius: could not parse the response body");
    }
    if (!Array.isArray(body)) throw new Error("helius: response was not an array");
    return body;
  }
}

// ------------------------------------------------------------------- the cache

type PageIndex = Record<string, string[]>;

function readPageIndex(): PageIndex {
  if (!existsSync(PAGE_INDEX)) return {};
  try {
    return JSON.parse(readFileSync(PAGE_INDEX, "utf8")) as PageIndex;
  } catch {
    return {};
  }
}

function cachePath(signature: string): string {
  // The signature is base58, so it cannot contain a path separator; still,
  // read it as an opaque name and refuse anything that is not base58.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,120}$/.test(signature)) throw new Error("helius: unusable signature");
  return join(CACHE_DIR, `${signature}.json`);
}

// -------------------------------------------------------------- the collection

type Collected = {
  transactions: EnhancedTx[];
  fromCache: number;
  fetched: number;
  capped: boolean;
  /** Pages that came back with fewer than `limit` entries. See the note in `collect`. */
  shortPages: number;
  /** Addresses whose history genuinely ran out, as opposed to running out of pages. */
  addressesExhausted: number;
};

async function collect(client: HeliusClient, addresses: string[]): Promise<Collected> {
  const index = readPageIndex();
  const seen = new Set<string>();
  const transactions: EnhancedTx[] = [];
  let fromCache = 0;
  let fetched = 0;
  let capped = false;
  let shortPages = 0;
  let addressesExhausted = 0;

  // An even split, so one high-volume venue cannot eat the whole budget and
  // leave the sample describing a single parser path.
  const perAddress = Math.max(1, Math.floor(client.cap / addresses.length));

  outer: for (const address of addresses) {
    let before: string | null = null;
    let pages = 0;
    while (pages < perAddress) {
      const key = `${address}:${before ?? "head"}`;
      let signatures: string[];

      if (index[key]) {
        signatures = index[key];
        for (const signature of signatures) {
          if (seen.has(signature)) continue;
          seen.add(signature);
          transactions.push(JSON.parse(readFileSync(cachePath(signature), "utf8")) as EnhancedTx);
          fromCache += 1;
        }
      } else {
        let page: unknown[];
        try {
          page = await client.page(address, before);
        } catch (error) {
          if (error instanceof BudgetExhausted) {
            capped = true;
            break outer;
          }
          throw error;
        }
        // Empty is the only end-of-history signal. A *short* page is not:
        // `type=SWAP` filters after the signature page is drawn, so a full
        // 100-signature page routinely comes back with fewer than 100 swaps
        // in it. Measured on the first request of this run — limit=100
        // returned 73 — and it is also the answer to "does a short page still
        // cost 100 credits": the request was made either way.
        if (page.length === 0) {
          addressesExhausted += 1;
          break;
        }

        if (transactions.length === 0 && fromCache === 0) assertShape(page[0]);

        signatures = [];
        for (const raw of page) {
          const tx = raw as EnhancedTx;
          const signature = tx?.signature;
          if (typeof signature !== "string" || signature.length === 0) continue;
          signatures.push(signature);
          writeFileSync(cachePath(signature), JSON.stringify(raw));
          if (seen.has(signature)) continue;
          seen.add(signature);
          transactions.push(tx);
          fetched += 1;
        }
        index[key] = signatures;
        writeFileSync(PAGE_INDEX, JSON.stringify(index));
        shortPages += page.length < PAGE_LIMIT ? 1 : 0;
      }

      pages += 1;
      const last = signatures.at(-1);
      if (!last) break;
      before = last;
    }
  }

  return { transactions, fromCache, fetched, capped, shortPages, addressesExhausted };
}

/**
 * The gate before the budget is spent: if the payload is not the shape
 * `parse-swap.ts` types, the measurement would be meaningless and the
 * remaining requests would be spent proving it.
 */
function assertShape(sample: unknown): void {
  const tx = sample as Record<string, unknown> | null;
  if (tx === null || typeof tx !== "object") throw new Error("shape mismatch: transaction is not an object");
  if (!Array.isArray(tx.accountData)) throw new Error("shape mismatch: accountData is not an array");
  const withChanges = (tx.accountData as Record<string, unknown>[]).find(
    (entry) => Array.isArray(entry?.tokenBalanceChanges) && (entry.tokenBalanceChanges as unknown[]).length > 0,
  );
  if (!withChanges) {
    console.log("shape note: the first transaction carried no tokenBalanceChanges; shape checked on later pages");
    return;
  }
  if (typeof withChanges.account !== "string") throw new Error("shape mismatch: accountData[].account");
  if (typeof withChanges.nativeBalanceChange !== "number") {
    throw new Error("shape mismatch: accountData[].nativeBalanceChange");
  }
  const change = (withChanges.tokenBalanceChanges as Record<string, unknown>[])[0];
  if (!("userAccount" in change)) throw new Error("shape mismatch: tokenBalanceChange.userAccount");
  if (typeof change.mint !== "string") throw new Error("shape mismatch: tokenBalanceChange.mint");
  const amount = change.rawTokenAmount as Record<string, unknown> | undefined;
  if (!amount || typeof amount !== "object") throw new Error("shape mismatch: tokenBalanceChange.rawTokenAmount");
  if (typeof amount.tokenAmount !== "string") throw new Error("shape mismatch: rawTokenAmount.tokenAmount");
  if (typeof amount.decimals !== "number") throw new Error("shape mismatch: rawTokenAmount.decimals");
  console.log("shape check: accountData / tokenBalanceChanges match what parse-swap.ts types");
}

// -------------------------------------------------------------- the measurement

type Verdict = { kind: "outcome"; label: string } | { kind: "malformed"; field: string } | { kind: "threw"; label: string };

const MALFORMED_PREFIX = "malformed enhanced transaction: ";

function verdictFor(payload: EnhancedTx, address: string): Verdict {
  try {
    // A non-null rate so a stablecoin-quoted swap is not refused for want of
    // one: this measures attribution, not valuation. 200 USD/SOL on the
    // 18-decimal grid prices.ts uses.
    const evaluation = evaluateSwap(payload, { id: "shadow", kolId: "shadow", address }, 200n * ONE);
    return { kind: "outcome", label: evaluation.outcome };
  } catch (error) {
    if (error instanceof MalformedPayloadError) {
      return { kind: "malformed", field: error.message.slice(MALFORMED_PREFIX.length) };
    }
    return { kind: "threw", label: error instanceof Error ? error.name : "unknown" };
  }
}

/** The payload as it would have been had Helius named every owner. */
function withOwnersNamed(payload: EnhancedTx): EnhancedTx {
  const clone = JSON.parse(JSON.stringify(payload)) as EnhancedTx;
  let n = 0;
  for (const entry of clone.accountData ?? []) {
    if (!Array.isArray(entry?.tokenBalanceChanges)) continue;
    for (const change of entry.tokenBalanceChanges) {
      if (change && typeof change === "object" && !readableOwner(change.userAccount)) {
        // A third party, deliberately: this is the optimistic counterfactual.
        // Where the unnamed owner was really the wallet itself, filling it in
        // would have produced a *different* trade, not merely an unrefused
        // one — stated in the report rather than modelled here.
        change.userAccount = `shadow-unnamed-owner-${n++}`;
      }
    }
  }
  return clone;
}

function readableOwner(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function increment(counter: Map<number, number>, key: number): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function histogram(counter: Map<number, number>): string {
  return [...counter.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => `${value}:${count}`)
    .join(" ");
}

type Report = Record<string, unknown>;

export function measure(transactions: EnhancedTx[]): Report {
  let changesTotal = 0;
  let changesEmptyOwner = 0;
  let changesMissingOwner = 0;
  let changesEmptyOwnerZero = 0;
  let txWithEmptyOwner = 0;

  const changesPerWalletTx = new Map<number, number>();
  let maxChangesPerWalletTx = 0;
  const changesPerTokenAccountMint = new Map<number, number>();
  let maxChangesPerTokenAccountMint = 0;
  const accountDataEntries = new Map<number, number>();
  let entriesWithChanges = 0;
  let entriesWithChangesAndNativeMove = 0;
  let txWithRepeatedMintForOneOwner = 0;
  let txWithRepeatedAccountEntry = 0;
  let residueRefusalsAtThreeOrMoreChanges = 0;
  const sources = new Map<string, number>();

  // Impact, feePayer as the tracked wallet — the shape a KOL swap has.
  let feePayerRaises = 0;
  let feePayerRaisesFromUnnamedOwner = 0;
  let feePayerRaisesOtherCause = 0;
  let feePayerTrades = 0;
  const feePayerOutcomes = new Map<string, number>();

  // Impact, worst case: every address the payload mentions treated as tracked.
  let walletsExamined = 0;
  let walletsRaisingFromUnnamedOwner = 0;

  for (const tx of transactions) {
    const entries = Array.isArray(tx.accountData) ? tx.accountData : [];
    increment(accountDataEntries, entries.length);
    sources.set(String((tx as unknown as Record<string, unknown>).source ?? "?"),
      (sources.get(String((tx as unknown as Record<string, unknown>).source ?? "?")) ?? 0) + 1);

    if (new Set(entries.map((entry) => entry?.account)).size < entries.length) txWithRepeatedAccountEntry += 1;

    let sawEmptyOwner = false;
    const perOwner = new Map<string, number>();
    const perOwnerMints = new Map<string, string[]>();
    const perTokenAccountMint = new Map<string, number>();

    for (const entry of entries) {
      const changes = Array.isArray(entry?.tokenBalanceChanges) ? entry.tokenBalanceChanges : [];
      if (changes.length > 0) {
        entriesWithChanges += 1;
        if (typeof entry.nativeBalanceChange === "number" && entry.nativeBalanceChange !== 0) {
          entriesWithChangesAndNativeMove += 1;
        }
      }
      for (const change of changes) {
        changesTotal += 1;
        const owner = (change as unknown as Record<string, unknown>)?.userAccount;
        if (owner === "") {
          changesEmptyOwner += 1;
          sawEmptyOwner = true;
          if (isProvablyZero(change)) changesEmptyOwnerZero += 1;
        } else if (!readableOwner(owner)) {
          changesMissingOwner += 1;
          sawEmptyOwner = true;
          if (isProvablyZero(change)) changesEmptyOwnerZero += 1;
        } else {
          const key = String(owner);
          perOwner.set(key, (perOwner.get(key) ?? 0) + 1);
          const mints = perOwnerMints.get(key) ?? [];
          mints.push(String((change as unknown as Record<string, unknown>).mint ?? "?"));
          perOwnerMints.set(key, mints);
        }
        const tokenAccount = (change as unknown as Record<string, unknown>)?.tokenAccount;
        const mint = (change as unknown as Record<string, unknown>)?.mint;
        if (typeof tokenAccount === "string" && typeof mint === "string") {
          const key = `${tokenAccount}|${mint}`;
          perTokenAccountMint.set(key, (perTokenAccountMint.get(key) ?? 0) + 1);
        }
      }
    }

    if (sawEmptyOwner) txWithEmptyOwner += 1;

    for (const count of perOwner.values()) {
      increment(changesPerWalletTx, count);
      if (count > maxChangesPerWalletTx) maxChangesPerWalletTx = count;
    }
    for (const count of perTokenAccountMint.values()) {
      increment(changesPerTokenAccountMint, count);
      if (count > maxChangesPerTokenAccountMint) maxChangesPerTokenAccountMint = count;
    }
    for (const mints of perOwnerMints.values()) {
      if (new Set(mints).size < mints.length) {
        txWithRepeatedMintForOneOwner += 1;
        break;
      }
    }

    const feePayer = typeof tx.feePayer === "string" ? tx.feePayer : null;
    const patched = sawEmptyOwner ? withOwnersNamed(tx) : tx;

    if (feePayer) {
      const real = verdictFor(tx, feePayer);
      feePayerOutcomes.set(describe(real), (feePayerOutcomes.get(describe(real)) ?? 0) + 1);
      if (real.kind === "malformed") {
        feePayerRaises += 1;
        const counterfactual = verdictFor(patched, feePayer);
        if (counterfactual.kind === "malformed") feePayerRaisesOtherCause += 1;
        else feePayerRaisesFromUnnamedOwner += 1;
      } else if (real.kind === "outcome" && real.label === "trade") {
        feePayerTrades += 1;
      }
      if (real.kind === "outcome" && real.label === "sol_leg_is_residue" && (perOwner.get(feePayer) ?? 0) >= 3) {
        residueRefusalsAtThreeOrMoreChanges += 1;
      }
    }

    for (const address of mentionedAddresses(tx)) {
      walletsExamined += 1;
      const real = verdictFor(tx, address);
      if (real.kind !== "malformed") continue;
      const counterfactual = verdictFor(patched, address);
      if (counterfactual.kind !== "malformed") walletsRaisingFromUnnamedOwner += 1;
    }
  }

  const n = transactions.length;
  return {
    transactions: n,
    changesTotal,
    changesEmptyOwner,
    changesMissingOwner,
    changesUnnamedOwnerProvablyZero: changesEmptyOwnerZero,
    txWithEmptyOwner,
    pctTxWithEmptyOwner: pct(txWithEmptyOwner, n),
    pctChangesEmptyOwner: pct(changesEmptyOwner + changesMissingOwner, changesTotal),
    feePayerTrades,
    feePayerRaises,
    feePayerRaisesFromUnnamedOwner,
    feePayerRaisesOtherCause,
    pctFeePayerRaisesFromUnnamedOwner: pct(feePayerRaisesFromUnnamedOwner, n),
    feePayerOutcomes: Object.fromEntries([...feePayerOutcomes.entries()].sort((a, b) => b[1] - a[1])),
    walletsExamined,
    walletsRaisingFromUnnamedOwner,
    pctWalletsRaisingFromUnnamedOwner: pct(walletsRaisingFromUnnamedOwner, walletsExamined),
    changesPerWalletTx: histogram(changesPerWalletTx),
    maxChangesPerWalletTx,
    changesPerTokenAccountMint: histogram(changesPerTokenAccountMint),
    maxChangesPerTokenAccountMint,
    accountDataEntries: histogram(accountDataEntries),
    entriesWithChanges,
    entriesWithChangesAndNativeMove,
    txWithRepeatedMintForOneOwner,
    txWithRepeatedAccountEntry,
    residueRefusalsAtThreeOrMoreChanges,
    sources: Object.fromEntries([...sources.entries()].sort((a, b) => b[1] - a[1])),
  };
}

function describe(verdict: Verdict): string {
  return verdict.kind === "malformed" ? `malformed:${verdict.field}` : `${verdict.kind}:${verdict.label}`;
}

/** Mirrors `candidateAddresses` in parse-swap.ts: every address the payload names. */
function mentionedAddresses(payload: EnhancedTx): string[] {
  const addresses = new Set<string>();
  for (const entry of Array.isArray(payload.accountData) ? payload.accountData : []) {
    if (readableOwner(entry?.account)) addresses.add(entry.account);
    for (const change of Array.isArray(entry?.tokenBalanceChanges) ? entry.tokenBalanceChanges : []) {
      const owner = (change as unknown as Record<string, unknown>)?.userAccount;
      if (readableOwner(owner)) addresses.add(String(owner));
    }
  }
  return [...addresses];
}

/** The same test `unattributableIsNonZero` applies, inverted. */
function isProvablyZero(change: unknown): boolean {
  const amount = (change as Record<string, unknown> | null)?.rawTokenAmount;
  if (amount === null || typeof amount !== "object") return false;
  const raw = (amount as Record<string, unknown>).tokenAmount;
  if (typeof raw === "number") return raw === 0;
  if (typeof raw !== "string" || !/^[+-]?\d+$/.test(raw)) return false;
  return BigInt(raw) === 0n;
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(3)}%`;
}

// --------------------------------------------------------------------- the run

async function main(): Promise<void> {
  const apiKey = requiredEnv("HELIUS_API_KEY");
  const addresses = requiredEnv("HELIUS_SHADOW_ADDRESSES")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (addresses.length === 0) throw new Error("HELIUS_SHADOW_ADDRESSES is not set");
  const cap = maxRequests();

  assertCacheIgnored();
  mkdirSync(CACHE_DIR, { recursive: true });

  const client = new HeliusClient(apiKey, cap);
  // The address count is safe to print; the addresses themselves are not.
  console.log(`shadow run: ${addresses.length} address(es), cap ${cap} requests`);

  const { transactions, fromCache, fetched, capped, shortPages, addressesExhausted } = await collect(client, addresses);
  const report = measure(transactions);

  console.log(JSON.stringify(report, null, 2));
  console.log(
    [
      "",
      capped
        ? `PARTIAL MEASUREMENT — aborted at the HELIUS_SHADOW_MAX_REQUESTS cap of ${cap} requests.`
        : addressesExhausted === addresses.length
          ? "COMPLETE — every address's history was read to its end."
          : `PARTIAL MEASUREMENT — the cap of ${cap} requests was not reached, but only ` +
            `${addressesExhausted} of ${addresses.length} addresses ran out of history; the rest ran ` +
            `out of their share of the page budget (${Math.max(1, Math.floor(cap / addresses.length))} pages each).`,
      `requests issued: ${client.requests}`,
      `credits spent:   ${client.requests * CREDITS_PER_REQUEST} ` +
        `(${client.requests} x ${CREDITS_PER_REQUEST}) = ` +
        `${((client.requests * CREDITS_PER_REQUEST) / 1_000_000 * 100).toFixed(3)}% of the 1,000,000 free monthly allowance`,
      `transactions:    ${transactions.length} (${fetched} fetched, ${fromCache} from cache)`,
      `short pages:     ${shortPages} of ${client.requests} came back under the limit of ${PAGE_LIMIT}`,
      `cached files:    ${readdirSync(CACHE_DIR).length - 1}`,
    ].join("\n"),
  );
}

// Guarded the way the other scripts in this directory guard theirs, so
// `measure` can be imported and re-run over the cache without the import
// itself spending credits.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
  // parse-swap.ts imports db.ts, which builds a pg Pool at module scope.
  // Nothing here queries it, but the module is loaded, so exit explicitly
  // rather than waiting on a handle this script never opened.
  process.exit(0);
}
