import { ImageResponse } from "next/og";
import { formatSignedSol, formatUnsignedUsd } from "@/lib/format";
import { kolFromSession, sessionTokenFrom } from "@/lib/session";
import { readKolDetail } from "@/lib/kol";
import { readProfile } from "@/lib/profile";
import { resolveWindow, WINDOW_LABELS, type LeaderboardWindow } from "@/lib/windows";
import { readLeaderboard } from "@/lib/leaderboard";

/**
 * `Exportar PnL Card`: la imagen del período, para compartir.
 *
 * **PNG y no SVG**, aunque el SVG habría sido menos código y sin fuentes: X no
 * acepta subir SVG, y una tarjeta que no se puede postear no es una tarjeta
 * para compartir. `ImageResponse` viene con Next —trae Geist adentro— así que
 * el PNG no cuesta una dependencia nueva ni un archivo de fuente en el repo.
 *
 * **Lleva lo que el molde pone y nada más:** medalla si entró en el podio, el
 * cabal si tiene, el PnL del período y el link del sitio. **No lleva ninguna
 * dirección**, ni operaciones, ni nada que reconstruya una transacción — es una
 * imagen que su dueño va a publicar, así que la regla de superficie pública
 * (`DECISIONES.md`, 2026-09-06) se aplica acá con más razón que en ningún otro
 * lado.
 *
 * La sesión decide de quién es la tarjeta. No hay parámetro de KOL: una ruta que
 * generara la tarjeta de otro sería una forma de publicar por él.
 */

export const runtime = "nodejs";

/** Los colores del sitio, escritos acá porque Satori no lee la hoja de estilos. */
const INK = "#0B0D0F";
const SURFACE = "#14181B";
const HAIRLINE = "#232A2F";
const TEXT = "#EDEDED";
const DIM = "#8A949B";
const GAIN = "#4ADE80";
const LOSS = "#F87171";
const BRAND = "#AB9FF2";

const MEDALS: Record<number, string> = { 1: "🏆", 2: "🥈", 3: "🥉" };

export async function GET(request: Request): Promise<Response> {
  const kolId = await kolFromSession(sessionTokenFrom(request));
  if (kolId === null) return new Response("unauthorized", { status: 401 });

  const profile = await readProfile(kolId);
  if (profile === null) return new Response("not found", { status: 404 });

  const params = new URL(request.url).searchParams;
  const resolved = resolveWindow(params.get("window"));
  const window: LeaderboardWindow =
    resolved !== null && typeof resolved === "string" ? resolved : "1d";

  const detail = await readKolDetail({ slug: profile.slug, window });
  if (detail === null) return new Response("not found", { status: 404 });

  // El puesto sale de la misma lista que la home ordena, así que la medalla de
  // la tarjeta y la de la fila no pueden discrepar.
  const board = await readLeaderboard({ window });
  const rank = board.entries.findIndex((entry) => entry.kol.slug === profile.slug) + 1;
  const medal = rank >= 1 && rank <= 3 ? MEDALS[rank] : null;

  const positive = !detail.realizedSol.startsWith("-");

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: INK,
          padding: 56,
          fontFamily: "Geist, sans-serif",
          color: TEXT,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {medal !== null && <span style={{ fontSize: 64 }}>{medal}</span>}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontSize: 48, fontWeight: 700 }}>{profile.name}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
              <span style={{ fontSize: 28, color: DIM }}>@{profile.handle}</span>
              {profile.cabalTag !== null && (
                <span
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: BRAND,
                    background: SURFACE,
                    border: `1px solid ${HAIRLINE}`,
                    borderRadius: 8,
                    padding: "4px 12px",
                  }}
                >
                  {profile.cabalTag}
                </span>
              )}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            background: SURFACE,
            border: `1px solid ${HAIRLINE}`,
            borderRadius: 16,
            padding: 32,
          }}
        >
          <span style={{ fontSize: 22, color: DIM, letterSpacing: 1 }}>
            PNL REALIZADO · {WINDOW_LABELS[window].toUpperCase()}
          </span>
          <span
            style={{
              fontSize: 92,
              fontWeight: 700,
              marginTop: 8,
              color: positive ? GAIN : LOSS,
            }}
          >
            {formatSignedSol(detail.realizedSol)}
          </span>
          <span style={{ fontSize: 34, color: DIM, marginTop: 4 }}>
            ({formatUnsignedUsd(detail.realizedUsd)})
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <span style={{ fontSize: 26, color: DIM }}>
            {rank >= 1 ? `Puesto ${rank}` : "Sin puesto en este período"}
          </span>
          <span style={{ fontSize: 30, fontWeight: 700, color: BRAND }}>
            kolscanhispano.fun
          </span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      headers: {
        // La tarjeta es de una persona y de un período: no puede quedar en
        // ninguna caché compartida.
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="pnl-${profile.handle}-${window}.png"`,
      },
    },
  );
}
