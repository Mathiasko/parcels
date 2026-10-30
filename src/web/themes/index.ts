/**
 * The theme registry. The page stylesheet is the base CSS followed by every theme here, each scoped to
 * `:root[data-theme="<id>"]`, so switching themes is only the attribute on `<html>`.
 */
import { DEFAULT_APPEARANCE, type ThemeId } from '../../core/appearance.js'
import { classic } from './classic.js'
import { COLOR_TOKENS, SHAPE_TOKENS, type Theme, type ThemeFont } from './types.js'

export const THEMES: readonly Theme[] = [classic]

export const DEFAULT_THEME: ThemeId = DEFAULT_APPEARANCE.theme

const fontFace = (f: ThemeFont) =>
  `@font-face{font-family:"${f.family}";src:url(/fonts/${f.file}) format("woff2");font-style:${f.style};font-weight:${f.weight};font-display:swap;unicode-range:${f.unicodeRange}}`

/** A theme's tokens (colours as `light-dark()` pairs, so `color-scheme` picks the mode), its fonts, then its own CSS. */
export function themeCss(theme: Theme): string {
  const colors = COLOR_TOKENS.map(tok => `--${tok}:light-dark(${theme.colors[tok].light},${theme.colors[tok].dark})`)
  const shapes = SHAPE_TOKENS.map(tok => `--${tok}:${theme.tokens[tok]}`)
  const root = `:root[data-theme="${theme.id}"]{${[...colors, ...shapes].join(';')}}`
  return [root, ...theme.fonts.map(fontFace), ...(theme.css ? [theme.css] : [])].join('\n')
}

export function themeById(id: string): Theme | undefined {
  return THEMES.find(t => t.id === id)
}
