/**
 * Mobile design tokens.
 *
 * Mirrors web/src/styles/tokens.css so the two clients feel like one product.
 * React Native has no CSS custom properties, so the values are duplicated here
 * rather than shared — keep them in step when either side changes.
 */

export const dark = {
  surfaceBase: '#0b0b0e',
  surfaceRaised: '#141418',
  surfaceOverlay: '#1c1c22',
  surfaceHover: '#24242b',

  textPrimary: '#f4f4f6',
  textSecondary: '#a1a1ad',
  textTertiary: '#6e6e7a',
  textInverse: '#0b0b0e',

  borderSubtle: 'rgba(255,255,255,0.07)',
  borderDefault: 'rgba(255,255,255,0.12)',

  accent: '#f2913d',
  accentMuted: 'rgba(242,145,61,0.16)',
  accentContrast: '#1a0f04',

  danger: '#f2555a',
  dangerMuted: 'rgba(242,85,90,0.14)',
  success: '#4ec98a',
} as const;

export const light = {
  surfaceBase: '#fbfbf9',
  surfaceRaised: '#ffffff',
  surfaceOverlay: '#ffffff',
  surfaceHover: '#f1f1ee',

  textPrimary: '#17171a',
  textSecondary: '#5f5f68',
  textTertiary: '#8b8b95',
  textInverse: '#ffffff',

  borderSubtle: 'rgba(0,0,0,0.07)',
  borderDefault: 'rgba(0,0,0,0.12)',

  accent: '#c96a15',
  accentMuted: 'rgba(201,106,21,0.12)',
  accentContrast: '#ffffff',

  danger: '#cf2f37',
  dangerMuted: 'rgba(207,47,55,0.1)',
  success: '#1d8a55',
} as const;

export type Palette = typeof dark;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  full: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 18,
  xl: 24,
  xxl: 30,
} as const;
