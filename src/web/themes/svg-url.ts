/**
 * An SVG as a CSS `url()`. It is percent-encoded (`%` first, then `<` `>` `#` `"`) so the stylesheet never
 * contains `</`, which would end the inline `<style>`, and so the data URL decodes back to exactly the SVG
 * (a raw `%` is not a valid escape). Write the SVG with single-quoted attributes: `"` closes the `url("…")`.
 */
export const svgUrl = (svg: string): string => {
  // `%` first, so the escapes added after it are not themselves re-escaped.
  const encoded = svg.replace(/%/g, '%25').replace(/[<>#"]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
  return `url("data:image/svg+xml;utf8,${encoded}")`
}
