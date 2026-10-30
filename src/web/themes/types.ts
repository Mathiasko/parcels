/**
 * The theme contract. The base stylesheet (`src/web/views/style.ts`) uses only custom properties; a theme
 * is the values of those properties, plus any fonts and ornaments of its own. Every theme defines every
 * colour token in light and dark (emitted as `light-dark()` pairs, so the mode is just `color-scheme`),
 * and every shape token once. The spec is docs/superpowers/specs/2026-10-30-themes-design.md §1.
 */
import type { ThemeId } from '../../core/appearance.js'

/**
 * `--signal` is the fill ("waiting on you"); `--signal-ink` is the same meaning as text or a glyph, so a
 * theme whose signal is a light fill (Postal's yellow) can still give it a readable text colour.
 */
export const COLOR_TOKENS = ['paper', 'surface', 'hover', 'rule', 'rule-s', 'edge', 'ink', 'ink-2', 'ink-3', 'signal', 'signal-ink', 'on-signal', 'signal-wash', 'warn', 'on-warn', 'warn-wash', 'ok', 'ok-wash', 'btn-hover'] as const
export type ColorToken = typeof COLOR_TOKENS[number]

/** Not colours, so set once per theme. `--texture` is a `background-image` value or `none`. */
export const SHAPE_TOKENS = ['font-display', 'font-body', 'font-mono', 'radius-card', 'radius-badge', 'radius-btn', 'shadow-card', 'texture'] as const
export type ShapeToken = typeof SHAPE_TOKENS[number]

/** One `@font-face`: a `.woff2` under assets/fonts/, served at `/fonts/<file>`. (Not `FontFace`: the DOM has one.) */
export interface ThemeFont {
  family: string
  file: string
  style: 'normal' | 'italic'
  weight: string
  unicodeRange: string
}

export interface Theme {
  id: ThemeId
  /** Shown in Settings. */
  name: string
  colors: Record<ColorToken, { light: string; dark: string }>
  tokens: Record<ShapeToken, string>
  fonts: ThemeFont[]
  /** The theme's own rules, each scoped to `[data-theme="<id>"]`. */
  css?: string
}
