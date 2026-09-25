/**
 * All money is handled as integer cents. No floating-point currency math
 * anywhere in the codebase — this module is the only place that computes
 * derived amounts, so rounding rules stay in one place.
 */

export function lineTotalCents(unitPriceCents: number, quantity: number): number {
  return unitPriceCents * quantity;
}

export function subtotalCents(lines: readonly { lineTotalCents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
}

/**
 * Floors (never rounds up) so a discount can never exceed the configured
 * percentage and a total can never go negative for percentOff in (0, 100].
 */
export function discountCents(subtotal: number, percentOff: number): number {
  return Math.floor((subtotal * percentOff) / 100);
}

export function totalAfterDiscount(subtotal: number, discount: number): number {
  const total = subtotal - discount;
  return total < 0 ? 0 : total;
}
