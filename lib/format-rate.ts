/**
 * A playback rate, as both the player and the side panel write it.
 *
 * `1×`, not `1.0×` or `1.00×`: the number comes from a slider with 0.05 steps,
 * and trailing zeros make a rate read like a version number. Shared rather than
 * duplicated because the panel's slider and the bar's rate button show the same
 * session, and two formatters would eventually disagree about it.
 */
export function formatRate(rate: number): string {
  return `${rate.toFixed(2).replace(/\.?0+$/, '')}×`;
}
