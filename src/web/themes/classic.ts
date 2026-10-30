/**
 * Classic: the look the dashboard had before themes, extracted unchanged. Every value here is the one the
 * stylesheet held directly, and a page in Classic must render pixel-identical to one from before themes
 * (spec §2). `--signal-ink` equals `--signal` in both modes, and `#ffffff` is the old `#fff` written out in
 * full so the contrast test can measure it.
 */
import type { Theme } from './types.js'

const SYSTEM_SANS = '-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"Helvetica Neue",sans-serif'

export const classic: Theme = {
  id: 'classic',
  name: 'Classic',
  colors: {
    paper: { light: '#f5f3ee', dark: '#151411' },
    surface: { light: '#fdfcf9', dark: '#1e1d19' },
    hover: { light: '#f0ede5', dark: '#26241f' },
    rule: { light: '#e3dfd5', dark: '#2f2d27' },
    'rule-s': { light: '#d2cdc0', dark: '#3a3830' },
    edge: { light: '#8c877a', dark: '#7a7669' },
    ink: { light: '#1a1915', dark: '#ece9e0' },
    'ink-2': { light: '#524f46', dark: '#b6b2a5' },
    'ink-3': { light: '#6b675c', dark: '#9a968a' },
    signal: { light: '#2a4bd1', dark: '#98a9ff' },
    'signal-ink': { light: '#2a4bd1', dark: '#98a9ff' },
    'on-signal': { light: '#ffffff', dark: '#0c1233' },
    'signal-wash': { light: '#e8ecfb', dark: '#1d2342' },
    warn: { light: '#b83c08', dark: '#ff9a6a' },
    'on-warn': { light: '#ffffff', dark: '#2a0f03' },
    'warn-wash': { light: '#fdf0e8', dark: '#34201a' },
    ok: { light: '#1b5a44', dark: '#74cdab' },
    'ok-wash': { light: '#e2f0e9', dark: '#1a2b25' },
    'btn-hover': { light: '#38362e', dark: '#fff' },
  },
  tokens: {
    'font-display': SYSTEM_SANS,
    'font-body': SYSTEM_SANS,
    'font-mono': 'ui-monospace,"SF Mono",Menlo,monospace',
    'radius-card': '12px',
    'radius-badge': '4px',
    'radius-btn': '6px',
    'shadow-card': 'none',
    texture: 'none',
  },
  fonts: [],
}
