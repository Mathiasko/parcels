/**
 * How the dashboard looks: which theme, and whether it follows the system's light/dark setting. These
 * live in core rather than in `src/web` because the config validates them and core must not import the
 * web layer; the theme registry in `src/web` asserts (by test) that its ids are exactly `THEME_IDS`.
 */

/** Every theme the dashboard can wear. The first is the default. */
export const THEME_IDS = ['postal', 'classic'] as const
export type ThemeId = typeof THEME_IDS[number]

/** `system` follows the OS; `light` and `dark` pin the page whatever the OS says. */
export const MODES = ['system', 'light', 'dark'] as const
export type Mode = typeof MODES[number]

export interface Appearance {
  theme: ThemeId
  mode: Mode
}

export const DEFAULT_APPEARANCE: Appearance = { theme: 'postal', mode: 'system' }
