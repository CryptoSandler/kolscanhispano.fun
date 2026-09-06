-- `kol_wallet.verified`: si la propiedad de esta wallet se probó con una firma.
--
-- **Supersede del invariante "cada wallet firma", 2026-09-06.** El molde
-- (`docs/clone-map.md` §11) firma **una vez, para entrar**, y las demás se
-- agregan pegando la dirección. Se copia el molde, con el riesgo aceptado
-- escrito en `DECISIONES.md`: un KOL puede anotar una wallet que no es suya.
--
-- **`DEFAULT true` y no `false`.** Todas las wallets que existen hoy entraron
-- por `/registro`, o sea con firma; ponerlas en `false` diría que no se probaron
-- y sería falso sobre el pasado. El default sirve además para el camino que
-- sigue firmando: `/registro` no tiene que acordarse de escribir la columna.
ALTER TABLE kol_wallet ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT true;

-- Cuándo se probó, para que `/admin` pueda ordenar por eso y para que una
-- validación posterior deje rastro de cuándo pasó.
ALTER TABLE kol_wallet ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Las que esperan validación, que es lo que `/admin` mira y lo que el perfil
-- lista arriba. Parcial porque son la minoría y la consulta siempre pregunta
-- por ellas, nunca por las verificadas.
CREATE INDEX IF NOT EXISTS kol_wallet_unverified
  ON kol_wallet (kol_id)
  WHERE verified = false AND status = 'active';

-- Las filas que ya existen se dan por probadas y con fecha desconocida:
-- `verified_at` queda en NULL, que es "no sabemos cuándo", no "nunca".
COMMENT ON COLUMN kol_wallet.verified IS
  'Propiedad probada con firma. Las pegadas a mano entran en false hasta que se validan.';
