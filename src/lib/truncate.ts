/**
 * Las dos formas truncadas de una dirección.
 *
 * **Viven acá y no en `public-wallets.ts` por una razón de bundle.** Ese módulo
 * importa `query` para leer la base, así que cualquier componente cliente que
 * tocara una de estas funciones se llevaba `pg` puesto y el build fallaba con
 * siete módulos de Node que no existen en el navegador. Cortar direcciones es
 * aritmética de strings y no tiene por qué saber de dónde salió la dirección.
 *
 * `public-wallets.ts` las reexporta para quien ya las importaba de ahí.
 */

/**
 * Six leading characters.
 *
 * `address-invariant.test.ts` measured six as the point where a base58 slice
 * stops colliding with Spanish prose by accident, and it is what the reference
 * sites print — a length people can compare against their own wallet at a
 * glance. EVM addresses keep their `0x`, which is how they are always written.
 */
export function truncateAddress(address: string): string {
  return address.slice(0, 6);
}

/**
 * `AbCdEf...wXyZ`, the mould's form inside the disclosure panel.
 *
 * Six and four, with the middle dropped. An address is recognisable from its
 * ends — which is why every explorer prints it this way — and unfindable
 * without its middle, which is why the middle is never published.
 */
export function truncateAddressLong(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
