import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import { beforeEach, describe, expect, it } from "vitest";
import { query } from "@/lib/db";
import { addWallet } from "@/lib/wallets";
import { openSession } from "@/lib/session";
import { PROOF_DOMAIN, proofMessage } from "@/lib/wallet-proof";
import { POST } from "./route";

/**
 * Validar una wallet pegada, y el caso de la wallet equivocada.
 *
 * Lo que más importa acá es lo segundo: **una wallet equivocada no gasta el
 * nonce**, así que el lector cambia de wallet en la extensión y toca `Validar`
 * de nuevo sin pedir nada. Es lo que el dueño pidió, copiado del molde.
 */
function wallet() {
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secret);
  return {
    address: bs58.encode(publicKey),
    sign: (message: string) =>
      bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret)),
  };
}

async function insertKol(slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO kol (id, slug, display_name, x_handle, status, approved_at)
     VALUES ($1, $2, $3, $4, 'approved', now())`,
    [id, slug, slug, slug],
  );
  return id;
}

function post(body: unknown, token: string | null): Request {
  return new Request("https://kolscanhispano.fun/api/perfil/validar", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `kh_session=${token}` } : {}),
      "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`,
    },
    body: JSON.stringify(body),
  });
}

/** Una wallet pegada: existe, es del KOL, y todavía no se probó. */
async function pasted(kolId: string, address: string): Promise<string> {
  const id = await addWallet(kolId, address, "solana");
  await query("UPDATE kol_wallet SET verified = false WHERE id = $1::uuid", [id]);
  return id;
}

beforeEach(async () => {
  await query("TRUNCATE kol, kol_wallet, kol_session, wallet_proof_nonce, rate_limit CASCADE");
});

describe("validar una wallet pegada", () => {
  it("refuses without a session", async () => {
    const response = await POST(post({ walletId: crypto.randomUUID() }, null));
    expect(response.status).toBe(401);
  });

  it("hands out a nonce and says which address has to sign", async () => {
    const kolId = await insertKol("uno");
    const signer = wallet();
    const walletId = await pasted(kolId, signer.address);
    const { token } = await openSession(kolId);

    const response = await POST(post({ walletId }, token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { nonce: string; expect: string };
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    // Truncada `6...4`: el KOL ya tiene la dirección, la pegó él.
    expect(body.expect).toMatch(/^.{6}\.\.\..{4}$/);
    expect(body.expect).not.toBe(signer.address);
  });

  it("turns a pasted wallet into a validated one when the right wallet signs", async () => {
    const kolId = await insertKol("uno");
    const signer = wallet();
    const walletId = await pasted(kolId, signer.address);
    const { token } = await openSession(kolId);

    const issued = (await (await POST(post({ walletId }, token))).json()) as {
      nonce: string;
      expiresAt: string;
    };
    const fields = {
      domain: PROOF_DOMAIN,
      address: signer.address,
      chain: "solana" as const,
      action: "agregar wallet" as const,
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
    };
    const response = await POST(
      post(
        { walletId, address: signer.address, signature: signer.sign(proofMessage(fields)), ...issued },
        token,
      ),
    );

    expect(response.status).toBe(200);
    const [row] = await query<{ verified: boolean; verified_at: Date | null }>(
      "SELECT verified, verified_at FROM kol_wallet WHERE id = $1::uuid",
      [walletId],
    );
    expect(row.verified).toBe(true);
    expect(row.verified_at).not.toBeNull();
  });

  /*
    **El caso que el dueño pidió, y el que más importa.**

    La extensión tiene conectada otra wallet. El mensaje tiene que nombrar las
    dos —la que hay que poner y la que está puesta— y el nonce tiene que quedar
    entero, para que cambiar de wallet y tocar `Validar` de nuevo alcance.
  */
  it("names both wallets and leaves the nonce unspent when the wrong one is connected", async () => {
    const kolId = await insertKol("uno");
    const mine = wallet();
    const other = wallet();
    const walletId = await pasted(kolId, mine.address);
    const { token } = await openSession(kolId);

    const issued = (await (await POST(post({ walletId }, token))).json()) as {
      nonce: string;
      expiresAt: string;
    };
    const fields = {
      domain: PROOF_DOMAIN,
      address: other.address,
      chain: "solana" as const,
      action: "agregar wallet" as const,
      nonce: issued.nonce,
      expiresAt: issued.expiresAt,
    };
    const response = await POST(
      post(
        { walletId, address: other.address, signature: other.sign(proofMessage(fields)), ...issued },
        token,
      ),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; expect: string; connected: string };
    expect(body.error).toBe("wrong_wallet");
    expect(body.expect).toMatch(/^.{6}\.\.\..{4}$/);
    expect(body.connected).toMatch(/^.{6}\.\.\..{4}$/);
    expect(body.expect).not.toBe(body.connected);

    // El nonce sigue entero: cambiar de wallet y firmar de nuevo tiene que
    // alcanzar, sin pedir otro.
    const [nonceRow] = await query<{ used_at: Date | null }>(
      "SELECT used_at FROM wallet_proof_nonce WHERE nonce = $1",
      [issued.nonce],
    );
    expect(nonceRow.used_at).toBeNull();

    // Y la wallet sigue sin validar.
    const [row] = await query<{ verified: boolean }>(
      "SELECT verified FROM kol_wallet WHERE id = $1::uuid",
      [walletId],
    );
    expect(row.verified).toBe(false);
  });

  it("lets the retry succeed on the very same nonce", async () => {
    // La consecuencia de lo de arriba, medida: el mismo nonce sirve después de
    // un intento con la wallet equivocada.
    const kolId = await insertKol("uno");
    const mine = wallet();
    const other = wallet();
    const walletId = await pasted(kolId, mine.address);
    const { token } = await openSession(kolId);

    const issued = (await (await POST(post({ walletId }, token))).json()) as {
      nonce: string;
      expiresAt: string;
    };
    const wrong = {
      domain: PROOF_DOMAIN, address: other.address, chain: "solana" as const,
      action: "agregar wallet" as const, nonce: issued.nonce, expiresAt: issued.expiresAt,
    };
    await POST(post({ walletId, address: other.address, signature: other.sign(proofMessage(wrong)), ...issued }, token));

    const right = { ...wrong, address: mine.address };
    const response = await POST(
      post({ walletId, address: mine.address, signature: mine.sign(proofMessage(right)), ...issued }, token),
    );
    expect(response.status).toBe(200);
  });

  it("refuses to validate somebody else's wallet", async () => {
    const mineKol = await insertKol("uno");
    const theirsKol = await insertKol("otra");
    const signer = wallet();
    const walletId = await pasted(theirsKol, signer.address);
    const { token } = await openSession(mineKol);

    const response = await POST(post({ walletId }, token));
    expect(response.status).toBe(404);
  });

  it("refuses a wallet that is already validated", async () => {
    const kolId = await insertKol("uno");
    const signer = wallet();
    const walletId = await addWallet(kolId, signer.address, "solana");
    const { token } = await openSession(kolId);

    const response = await POST(post({ walletId }, token));
    expect(response.status).toBe(409);
  });
});
