import { formatDecimal, mulDiv, ONE, parseDecimal } from "./decimal";

/**
 * Un total en dólares, en pesos, como string decimal para el formateador.
 *
 * Por `decimal.ts` y su `bigint` escalado, nunca por `Number`: la
 * multiplicación es el único paso donde un double parecería inofensivo y
 * perdería los últimos dígitos de una cifra que este producto imprime.
 *
 * **Vive acá y no en `fx.ts` por una razón de bundle.** `fx.ts` importa
 * `query` para leer la cotización guardada, así que cualquier componente
 * cliente que tocara `usdToArs` se llevaba `pg` puesto — y el build falló con
 * siete módulos de Node que no existen en el navegador (`dns`, `fs`, `net`,
 * `tls`). La conversión es aritmética pura y no tiene por qué saber de dónde
 * salió la cotización; `fx.ts` la reexporta para quien ya la importaba de ahí.
 */
export function usdToArs(usdText: string, rate: string): string {
  return formatDecimal(mulDiv(parseDecimal(usdText), parseDecimal(rate), ONE));
}
