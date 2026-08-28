# Decisiones

Registro de decisiones que no se leen del código. Cada una con su fecha, su razón, y
lo que cuesta si estuvo mal.

---

## 2026-08-28 — La tanda de seguridad va en su propia rama, sobre `estetica-kolscan`

`seguridad-post-auditoria`, con base en `20040c7`, **no** en `main`.

**Por qué sobre `estetica` y no sobre `main`:** tres de los hallazgos —H-1 (el blind index
en la query de KOL-detail), M-2 y M-3 (la ruta de avatar y su `Cache-Control`)— viven en
archivos que **sólo existen en `estetica-kolscan`**. `src/lib/kol.ts` y
`src/app/api/avatar/[kolId]/` no están en `main`. Una rama desde `main` no podría
arreglarlos.

**Por qué rama propia y no commits arriba de `estetica`:** el gate visual del dueño sobre
`estetica` sigue pendiente, y el diff que revisó no debería crecer con veintitantos
cambios de seguridad mientras lo mira. Una tanda de seguridad se revisa como tanda de
seguridad.

**Costo si estuvo mal:** si el dueño quiere los arreglos que también aplican a `main`
—M-1, M-5, M-6, `db.ts:44`, F1 a F7— antes de cerrar el gate estético, hay que
cherry-pickearlos. Es trabajo, pero es trabajo acotado y visible; partir la tanda ahora,
en cambio, duplicaría el esfuerzo para un gate que puede cerrarse pronto.

---

## 2026-08-28 — F8 (CSP con nonces) queda diferido

`next.config.ts:24` sirve `script-src 'self' 'unsafe-inline'` en producción. Reemplazarlo
por nonces por request es un cambio propio, no una línea: toca el middleware, el layout y
cada script inline, y hay que verificarlo contra el streaming de React.

Decisión del dueño, 2026-08-28: **fuera de esta tanda**, anotado acá para que no se
pierda. El propio `next.config.ts` ya documenta el trade-off en el lugar donde vive.

**Costo si estuvo mal:** un XSS que hoy sería contenido por un nonce hoy no lo está. El
resto de la CSP —`object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
`form-action 'self'`— sigue en pie, y la auditoría no encontró ninguna primitiva de
inyección en la UI (cero `dangerouslySetInnerHTML`, cero `innerHTML`, cero `eval`).
