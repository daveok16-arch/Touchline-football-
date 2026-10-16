/**
 * Project Touchline – design tokens (typography + spacing).
 *
 * Single source of truth for the type scale and spacing scale. The same values are mirrored by
 * the `@theme` block in `src/index.css`, which turns them into Tailwind utilities
 * (`font-sans`, `text-2xs`, `px-gutter-sm`, `pb-section-xl`, `max-w-shell`, ...). Keep the two in
 * sync; the layout shell and the design-token tests both read from here.
 *
 * The spacing scale is a 4px base (`0.25rem` unit) plus a few semantic layout tokens
 * (header height, page gutters, section rhythm, shell max width).
 */

/** Typography tokens: families, sizes, line heights, weights, tracking. */
export const fontFamilies = {
  sans: "'Plus Jakarta Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
} as const;

export const fontSizes = {
  '2xs': '0.625rem',
  xs: '0.75rem',
  sm: '0.875rem',
  base: '1rem',
  lg: '1.125rem',
  xl: '1.25rem',
  '2xl': '1.5rem',
  '3xl': '1.875rem',
  '4xl': '2.25rem',
} as const;

export const lineHeights = {
  tight: '1.25',
  normal: '1.5',
  relaxed: '1.625',
} as const;

export const fontWeights = {
  normal: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
} as const;

export const letterSpacings = {
  tight: '-0.025em',
  normal: '0',
  wide: '0.025em',
  wider: '0.05em',
  widest: '0.1em',
} as const;

/** Base 4px spacing scale (mirrors Tailwind's numeric spacing utilities). */
export const spacingScale = {
  px: '1px',
  0: '0',
  0.5: '0.125rem',
  1: '0.25rem',
  1.5: '0.375rem',
  2: '0.5rem',
  2.5: '0.625rem',
  3: '0.75rem',
  3.5: '0.875rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  16: '4rem',
  20: '5rem',
  24: '6rem',
} as const;

/** Semantic layout spacing used by the app shell (header, gutters, section rhythm). */
export const layoutSpacing = {
  header: '4rem', // sticky header height
  gutter: '1rem', // page gutter, mobile
  'gutter-sm': '1.5rem', // page gutter, >= sm
  'gutter-lg': '2rem', // page gutter, >= lg
  section: '1.5rem', // vertical rhythm between sections
  'section-lg': '2rem',
  'section-xl': '5rem', // bottom breathing room above the footer
} as const;

/** Shell container widths. */
export const containerWidths = {
  shell: '80rem', // 1280px content column
} as const;

export const typographyTokens = {
  fontFamilies,
  fontSizes,
  lineHeights,
  fontWeights,
  letterSpacings,
} as const;

export const spacingTokens = {
  spacingScale,
  layoutSpacing,
  containerWidths,
} as const;

export const designTokens = { typography: typographyTokens, spacing: spacingTokens } as const;
