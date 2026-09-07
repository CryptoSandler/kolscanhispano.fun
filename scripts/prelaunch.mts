import { loadEnvLocal } from "../src/lib/env";
loadEnvLocal();

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { announceDatabaseTarget, query } from "../src/lib/db";
import { ARS_WARN_AFTER_MS, FX_SETTING_KEY, parseArsRates } from "../src/lib/fx";
import { hostFragment } from "../src/lib/connection-identity";

/**
 * `npm run prelaunch` — ¿está todo vivo?
 *
 * **Cada verificación es una llamada real, no una lectura de configuración.**
 * Ésa es la regla que ordena este archivo, y viene de un caso concreto: el
 * 2026-09-07 el cron de `parse-pending` informó `refreshed 29 of 29` mientras
 * las 29 llamadas a Helius devolvían 401, porque contaba filas escritas y no
 * respuestas recibidas. Una verificación que lee una variable de entorno y dice
 * "la clave está configurada" habría dicho lo mismo, y también habría estado
 * mal. Preguntarle a Helius es lo único que distingue una clave puesta de una
 * clave que sirve.
 *
 * Falla ruidoso: imprime **todo** lo que está mal, no lo primero, porque quien
 * corre esto antes de lanzar quiere la lista entera y no un descubrimiento por
 * vez.
 *
 * Corre también como job diario (`.github/workflows/prelaunch.yml`), que abre un
 * issue cuando falla. Un check que sólo corre cuando alguien se acuerda es un
 * check que no corrió el día que importaba.
 */

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  /** `true` cuando el fallo no bloquea el lanzamiento pero hay que saberlo. */
  warn?: boolean;
};

const checks: Check[] = [];
/** Devuelve `void` a propósito: `return add(...)` es la forma corta de "anotá y salí". */
function add(name: string, ok: boolean, detail: string, warn = false): void {
  checks.push({ name, ok, detail, warn });
}

/** Cuánto puede hacer que un webhook no entrega antes de preocuparse. */
const DELIVERY_WINDOW_MIN = 30;

/** Cuánto puede hacer que un cron no corre. Los dos más lentos son horarios. */
const CRON_WINDOW_MIN = 90;

/**
 * Los prefijos permitidos salen de `docs/credenciales.md`, parseados de su
 * tabla, y no de una constante acá: el documento es lo que una persona lee y
 * edita al rotar, y una lista duplicada en código se queda vieja sin avisar.
 */
function allowedPrefixes(): Map<string, { prefix: string; account: string }> {
  const doc = readFileSync(join(process.cwd(), "docs/credenciales.md"), "utf8");
  const allowed = new Map<string, { prefix: string; account: string }>();
  for (const line of doc.split("\n")) {
    // | Servicio | `VARIABLE` | Cuenta | `prefijo` |
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length !== 6) continue;
    const variable = cells[2].replace(/`/g, "");
    const prefix = cells[4].replace(/`/g, "");
    if (/^[A-Z][A-Z0-9_]*$/.test(variable) && prefix) {
      allowed.set(variable, { prefix, account: cells[3] });
    }
  }
  return allowed;
}

/** El valor tal como está en el archivo, sin pasar por `process.env`. */
function fromEnvLocal(name: string): string | null {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const match = line.match(new RegExp(`^${name}=(.*)$`));
      if (match) return match[1].trim().replace(/^"|"$/g, "");
    }
  } catch {
    /* en CI no hay archivo, y ahí la única fuente es el secret */
  }
  return null;
}

/** De una URL de RPC, la key es el último segmento del path. */
function credentialOf(name: string, raw: string): string {
  return name.endsWith("_URL") ? raw.split("?")[0].replace(/\/$/, "").split("/").pop() ?? "" : raw;
}

/**
 * ¿Las credenciales son de una cuenta CryptoSandler?
 *
 * Compara **prefijos**, nunca valores: ocho caracteres de un UUID identifican una
 * key sin abrirla, y así el fallo puede decir cuál es sin filtrar nada.
 *
 * Comprueba dos cosas distintas, porque hoy fallaron las dos por separado:
 *
 * 1. La key que **este proceso resolvió** está en la lista. En el job diario eso
 *    es el secret de CI, que es una de las tres copias que hoy tenían la key
 *    personal.
 * 2. La shell y `.env.local` **dicen lo mismo**. `--env-file` y `loadEnvLocal`
 *    rellenan lo que falta y no pisan lo que sobra, así que una variable vieja
 *    exportada gana en silencio: el archivo queda bien, el proceso usa otra, y
 *    todo informe que lea `process.env` confirma la equivocada. Fue el camino
 *    exacto por el que la key personal llegó a Vercel el 2026-09-06.
 */
function checkCredentialAccounts(): void {
  for (const [variable, { prefix, account }] of allowedPrefixes()) {
    const live = process.env[variable]?.trim();
    if (!live) {
      add("credenciales: cuenta", false, `${variable} no está en este entorno`, true);
      continue;
    }
    const inUse = credentialOf(variable, live);
    add(
      `credenciales: ${variable}`,
      inUse.startsWith(prefix),
      inUse.startsWith(prefix)
        ? `${prefix}… — ${account}`
        : `la key en uso empieza con ${inUse.slice(0, prefix.length)}…, ` +
          `no está en docs/credenciales.md (se espera ${prefix}…, ${account})`,
    );

    const onDisk = fromEnvLocal(variable);
    if (onDisk !== null && credentialOf(variable, onDisk) !== inUse) {
      add(
        `credenciales: ${variable} shell vs archivo`,
        false,
        "la shell exporta una key distinta de la de .env.local y gana; " +
          "este proceso está usando la de la shell",
      );
    }
  }
}

async function checkHeliusKey(): Promise<void> {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) return add("helius: clave", false, "HELIUS_API_KEY no está en este entorno");
  try {
    // La llamada más barata que Helius atiende: si la clave no sirve, 401.
    const response = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(10_000),
    });
    add(
      "helius: clave",
      response.status === 200,
      response.status === 200 ? "getHealth 200" : `getHealth ${response.status} — la clave no sirve`,
    );
  } catch (error) {
    add("helius: clave", false, `no se pudo consultar: ${String(error).slice(0, 60)}`);
  }
}

async function checkHeliusWebhook(): Promise<void> {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) return add("helius: webhook", false, "sin clave no se puede preguntar");
  try {
    const response = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${key}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return add("helius: webhook", false, `la API respondió ${response.status}`);
    }
    const hooks = (await response.json()) as {
      webhookID?: string;
      webhookURL?: string;
      active?: boolean;
    }[];
    const ours = hooks.find((hook) => hook.webhookURL?.includes("kolscanhispano"));
    if (!ours) return add("helius: webhook", false, `ninguno de ${hooks.length} apunta acá`);

    /*
      **El listado no trae las direcciones, y esa suposición se comprobó.**

      La primera versión leía `accountAddresses` del listado y lo encontraba
      `undefined`, así que reportaba "no vigila ninguna dirección" — un rojo
      inventado, en una corrida donde el webhook estaba entregando payloads.
      Verificado el 2026-09-07: el listado devuelve `webhookID, project, wallet,
      webhookURL, transactionTypes, webhookType, authHeader, active` y nada más.
      Las direcciones vienen del detalle, que es una segunda llamada.
    */
    const detail = await fetch(
      `https://api.helius.xyz/v0/webhooks/${ours.webhookID}?api-key=${key}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const watching = detail.ok
      ? (((await detail.json()) as { accountAddresses?: string[] }).accountAddresses?.length ?? 0)
      : -1;

    if (ours.active !== true) return add("helius: webhook", false, "existe pero está inactivo");
    if (watching < 0) return add("helius: webhook", false, "activo, pero el detalle no respondió");
    add(
      "helius: webhook",
      watching > 0,
      watching > 0 ? `activo, ${watching} direcciones` : "activo pero sin direcciones que vigilar",
    );
  } catch (error) {
    add("helius: webhook", false, `no se pudo consultar: ${String(error).slice(0, 60)}`);
  }
}

/** Vigilar no es entregar: esto pregunta si llegó algo hace poco. */
async function checkDelivery(): Promise<void> {
  const [row] = await query<{ last: Date | null; recent: number }>(
    `SELECT max(received_at) AS last,
            count(*) FILTER (WHERE received_at > now() - ($1 || ' minutes')::interval)::int AS recent
       FROM raw_tx`,
    [String(DELIVERY_WINDOW_MIN)],
  );
  const last = row.last ? new Date(row.last).toISOString() : "nunca";
  add(
    "helius: entrega",
    row.recent > 0,
    row.recent > 0
      ? `${row.recent} payloads en ${DELIVERY_WINDOW_MIN} min (último ${last})`
      : `sin payloads en ${DELIVERY_WINDOW_MIN} min (último ${last})`,
  );
}

async function checkAlchemyWebhook(): Promise<void> {
  const token = process.env.ALCHEMY_AUTH_TOKEN?.trim();
  if (!token) {
    return add(
      "alchemy: webhook",
      false,
      "ALCHEMY_AUTH_TOKEN no está en este entorno",
      true,
    );
  }
  try {
    const response = await fetch("https://dashboard.alchemy.com/api/team-webhooks", {
      headers: { "X-Alchemy-Token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return add("alchemy: webhook", false, `la API respondió ${response.status}`);
    const body = (await response.json()) as { data?: { webhook_url?: string; is_active?: boolean }[] };
    const ours = (body.data ?? []).find((hook) => hook.webhook_url?.includes("kolscanhispano"));
    if (!ours) {
      /*
        Sin wallets BNB de KOLs aprobados no hay webhook que registrar —
        `sync-bnb-webhook.mts` se niega a crear uno vacío porque parecería
        registrado y no entregaría nada. Es un aviso, no un bloqueo.
      */
      const [{ n }] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM kol_wallet w JOIN kol k ON k.id = w.kol_id
          WHERE w.chain = 'bnb' AND w.status = 'active' AND k.status = 'approved'`,
      );
      return add(
        "alchemy: webhook",
        n === 0,
        n === 0
          ? "sin registrar, y no hace falta: ningún KOL aprobado tiene wallet BNB"
          : `${n} wallets BNB activas y ningún webhook que las mire`,
        n === 0,
      );
    }
    add("alchemy: webhook", ours.is_active === true, ours.is_active ? "activo" : "existe pero inactivo");
  } catch (error) {
    add("alchemy: webhook", false, `no se pudo consultar: ${String(error).slice(0, 60)}`, true);
  }
}

/**
 * Los crons, por su efecto y no por su tilde verde.
 *
 * Un run puede terminar en `success` con todo su trabajo fallando —pasó el
 * 2026-09-07— así que acá se mira lo que dejaron escrito: el minuto más nuevo
 * de `sol_price` y la marca de la cotización.
 */
async function checkCrons(): Promise<void> {
  const [price] = await query<{ last: Date | null }>("SELECT max(minute) AS last FROM sol_price");
  const ageMin = price.last ? (Date.now() - new Date(price.last).getTime()) / 60_000 : Infinity;
  add(
    "cron: sol_price",
    ageMin < CRON_WINDOW_MIN,
    Number.isFinite(ageMin)
      ? `último minuto hace ${Math.round(ageMin)} min`
      : "la serie está vacía",
  );
}

async function checkArsRate(): Promise<void> {
  const [row] = await query<{ value: unknown }>("SELECT value FROM setting WHERE key = $1", [
    FX_SETTING_KEY,
  ]);
  const rates = parseArsRates(row?.value);
  const quote = rates?.casas.blue;
  if (!quote) return add("ars: blue", false, "no hay cotización guardada");
  const ageMs = Date.now() - new Date(quote.asOf).getTime();
  const ageH = ageMs / 3_600_000;
  add(
    "ars: blue",
    ageMs < ARS_WARN_AFTER_MS,
    `cotizado hace ${ageH.toFixed(1)} h (el umbral de aviso son 6)`,
  );
}

/**
 * La PnL Card, generada de verdad.
 *
 * Abre una sesión para un KOL que ya existe, pide la imagen y **cierra la
 * sesión**: dos escrituras en `kol_session`, las dos reversibles, a cambio de
 * saber que la ruta produce un PNG y no un 500. Comprobar que el archivo existe
 * no distingue una ruta que renderiza de una que explota al renderizar.
 */
async function checkPnlCard(): Promise<void> {
  const [kol] = await query<{ id: string }>(
    "SELECT id FROM kol WHERE status = 'approved' ORDER BY approved_at LIMIT 1",
  );
  if (!kol) return add("pnl card", false, "no hay ningún KOL aprobado para probar");

  const { openSession, closeSession } = await import("../src/lib/session");
  const { GET } = await import("../src/app/api/perfil/pnl-card/route");
  const { token } = await openSession(kol.id);
  try {
    const response = await GET(
      new Request("https://kolscanhispano.fun/api/perfil/pnl-card", {
        headers: { cookie: `kh_session=${token}` },
      }),
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    const isPng = bytes.subarray(0, 4).toString("hex") === "89504e47";
    add(
      "pnl card",
      response.status === 200 && isPng,
      response.status === 200 && isPng
        ? `PNG de ${bytes.length} bytes`
        : `status ${response.status}, ${isPng ? "png" : "no es png"}`,
    );
  } catch (error) {
    add("pnl card", false, `falló al generar: ${String(error).slice(0, 70)}`);
  } finally {
    await closeSession(token, "prelaunch");
  }
}

/** Las migraciones del checkout contra las de la base que este proceso abre. */
async function checkMigrations(): Promise<void> {
  const onDisk = readdirSync(join(process.cwd(), "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .map((file) => file.replace(/\.sql$/, ""))
    .sort();
  const applied = new Set(
    (await query<{ version: string }>("SELECT version FROM schema_migrations")).map(
      (row) => row.version,
    ),
  );
  const missing = onDisk.filter((version) => !applied.has(version));
  add(
    "migraciones",
    missing.length === 0,
    missing.length === 0
      ? `las ${onDisk.length} aplicadas (última ${onDisk[onDisk.length - 1]})`
      : `faltan: ${missing.join(", ")}`,
  );
}

/**
 * `noindex`, en el estado que este momento espera.
 *
 * Antes de lanzar tiene que **estar**; después de lanzar, no. `PRELAUNCH_INDEXABLE=1`
 * invierte la expectativa, y ése es el interruptor que se toca el día del
 * lanzamiento en vez de borrar el check.
 */
async function checkNoindex(): Promise<void> {
  const wantIndexable = process.env.PRELAUNCH_INDEXABLE === "1";
  try {
    const response = await fetch("https://kolscanhispano.fun/", {
      signal: AbortSignal.timeout(10_000),
    });
    const html = await response.text();
    const hasNoindex = /noindex/i.test(html);
    add(
      "noindex",
      hasNoindex !== wantIndexable,
      wantIndexable
        ? hasNoindex
          ? "el sitio todavía dice noindex y ya debería indexarse"
          : "indexable, como corresponde después del lanzamiento"
        : hasNoindex
          ? "presente, como corresponde antes del lanzamiento"
          : "AUSENTE: el sitio se puede indexar y todavía no lanzó",
    );
  } catch (error) {
    add("noindex", false, `no se pudo leer el sitio: ${String(error).slice(0, 60)}`);
  }
}

async function main(): Promise<number> {
  announceDatabaseTarget();

  checkCredentialAccounts();
  await checkHeliusKey();
  await checkHeliusWebhook();
  await checkDelivery();
  await checkAlchemyWebhook();
  await checkCrons();
  await checkArsRate();
  await checkPnlCard();
  await checkMigrations();
  await checkNoindex();

  const failures = checks.filter((check) => !check.ok && !check.warn);
  const warnings = checks.filter((check) => !check.ok && check.warn);

  console.log("");
  for (const check of checks) {
    const mark = check.ok ? "ok  " : check.warn ? "aviso" : "FALLA";
    console.log(`${mark}  ${check.name.padEnd(20)} ${check.detail}`);
  }
  console.log("");

  if (warnings.length > 0) {
    console.log(`${warnings.length} aviso(s): ${warnings.map((c) => c.name).join(", ")}`);
  }
  if (failures.length > 0) {
    console.error(
      `prelaunch: ${failures.length} verificación(es) en rojo — ${failures
        .map((check) => check.name)
        .join(", ")}`,
    );
    return 1;
  }
  console.log("prelaunch: todo en verde");
  return 0;
}

process.exit(await main());
