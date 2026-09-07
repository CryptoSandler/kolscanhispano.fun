import { ImageResponse } from "next/og";

/**
 * La imagen de Open Graph: el wordmark sobre el fondo del sitio.
 *
 * Se genera con `ImageResponse` en vez de guardarse como archivo por la misma
 * razón que la PnL Card: Next trae la fuente adentro, así que no hay un PNG que
 * mantener sincronizado con el wordmark cuando el wordmark cambie.
 *
 * **Sin la bandera.** El ícono de la pestaña es la bandera y esto es la tarjeta
 * de un enlace compartido: a 1200×630 lo que se lee es el nombre, y una bandera
 * ahí compite con él sin agregar nada que el nombre no diga.
 */
export const runtime = "nodejs";
export const alt = "KOLScan Hispano";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0B0D0F",
          fontFamily: "Geist, sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 96, fontWeight: 700 }}>
          <span style={{ color: "#EDEDED" }}>KOLScan</span>
          {/* El acento del wordmark: `Hispano` en el rojo de la bandera. */}
          <span style={{ color: "#AA151B", marginLeft: 18 }}>Hispano</span>
        </div>
        <span style={{ marginTop: 20, fontSize: 34, color: "#8A949B" }}>
          Clasificación de traders hispanos
        </span>
      </div>
    ),
    size,
  );
}
