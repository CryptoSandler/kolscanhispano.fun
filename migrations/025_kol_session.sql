-- Sesión del KOL: la cookie que emite la firma del nonce.
--
-- **Supersede de spec §6, "sin sesión", por decisión del dueño del 2026-09-06.**
-- El producto no tenía cuentas: `/registro` firmaba y se acababa ahí, y el chip
-- del header decía la acción de conectar porque no había nadie a quien saludar.
-- El perfil del KOL —"Mis wallets", agregar, ocultar, exportar— necesita saber
-- quién está mirando, y eso es una sesión.
--
-- **Una tabla y no una cookie firmada**, que era la alternativa barata. Tres
-- razones, y la tercera es la que decide:
--
--   1. Se puede revocar. Una cookie firmada vale hasta que expira o hasta que
--      se rota la clave, y rotar la clave cierra la sesión de todos.
--   2. Se puede listar: el admin puede ver que un KOL tiene sesión abierta.
--   3. `docs/round-hardening-wallets.md` (2026-09-06) recomienda que el
--      mecanismo de credenciales con expiración se construya **una vez** —
--      `ADMIN_TOKEN` también lo necesita. Una cookie firmada acá habría sido la
--      mitad de un mecanismo que después hay que construir entero igual.
--
-- El token se guarda **hasheado**, como una contraseña: la fila no sirve para
-- entrar. Un dump de esta tabla no abre ninguna sesión.
CREATE TABLE IF NOT EXISTS kol_session (
  -- SHA-256 del token que viaja en la cookie. Nunca el token.
  token_hash  BYTEA PRIMARY KEY,
  kol_id      UUID NOT NULL REFERENCES kol(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  -- Cuándo se cerró, y por quién. `NULL` mientras está viva.
  revoked_at  TIMESTAMPTZ,
  revoked_by  TEXT
);

-- Las sesiones vivas de un KOL, que es lo que `/admin` mira y lo que un
-- "cerrar todas las sesiones" recorrería.
CREATE INDEX IF NOT EXISTS kol_session_kol_live
  ON kol_session (kol_id)
  WHERE revoked_at IS NULL;

-- La limpieza de expiradas es por fecha.
CREATE INDEX IF NOT EXISTS kol_session_expires ON kol_session (expires_at);
