export type FieldKind = 'E' | 'H' | 'J' | 'S'
export const FIELD_COLORS: Record<FieldKind, string> = { E: '#2c4a72', H: '#2f6a4c', J: '#cf4520', S: '#b07d12' }
export const FIELD_COLORS_DARK: Record<FieldKind, string> = { E: '#86a6d1', H: '#62b086', J: '#e5653d', S: '#d9a23a' }
/** The fields view draws the board this many times thicker so the inside is visible. */
export const THICK = 4

/** Where we are in the cycle, as a fraction of the period T. */
export function phaseLabel(t: number) {
  const k = ((t / (2 * Math.PI)) % 1 + 1) % 1
  return `${k.toFixed(2)} T`
}
