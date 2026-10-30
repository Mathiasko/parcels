/**
 * WCAG 2 contrast between two `#rrggbb` colours, for the theme contrast tests. Strict on purpose: a
 * shorthand (`#fff`), a name or a function in a token that is checked for contrast is a test error rather
 * than a guess, so every checked token stays something this fixture can actually measure.
 */
const HEX = /^#[0-9a-f]{6}$/i

function luminance(hex: string): number {
  if (!HEX.test(hex)) throw new Error(`not a #rrggbb colour: ${JSON.stringify(hex)}`)
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
