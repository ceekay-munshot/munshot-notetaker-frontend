/** @type {import('tailwindcss').Config} */
// Munshot Notetaker design tokens — clean, minimal, editorial SaaS, dressed in
// the Munshot brand: the gold "M" monogram on near-black navy (public/munshot-mark.jpeg).
// Near-white (subtly warm) canvas, white cards with faint borders + shadows, a
// single gold accent, Inter type scale. Token NAMES are kept stable so the whole
// app re-skins from this one file.
//
// On the gold: the logo's bright mark (#f5a623) only clears ~2:1 on white, so it
// is reserved for fills, gradients and dark-surface accents. Anything that has to
// be *read* — text, icons, solid buttons — uses the deep gold `primary` (#9c6209,
// 5.0:1 on white, and the same 5.0:1 for white text sitting on it).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#fafaf8',
        'on-background': '#12121a',
        surface: '#ffffff',
        'surface-dim': '#eeece7',
        'surface-bright': '#ffffff',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f7f6f3',
        'surface-container': '#f2f1ec',
        'surface-container-high': '#ebe9e3',
        'surface-container-highest': '#e5e2db',
        'surface-variant': '#f2f1ec',
        // Ink drawn from the logo's near-black navy ground.
        'on-surface': '#12121a',
        // Body / reading text — a warm dark grey: strong and low-effort to read,
        // while staying clearly below headings.
        'on-surface-variant': '#3f3b36',
        'inverse-surface': '#0b0a12',
        'inverse-on-surface': '#faf9f6',
        outline: '#9a948a',
        'outline-variant': '#e8e5de',
        'surface-tint': '#9c6209',
        // Deep gold — the readable end of the brand ramp (5.0:1 on white).
        primary: '#9c6209',
        'on-primary': '#ffffff',
        'primary-container': '#7c4a06',
        'on-primary-container': '#7c4a06',
        'primary-fixed': '#fdf3de',
        'primary-fixed-dim': '#f9e0aa',
        // Light gold, for accents that sit on the dark inverse surfaces.
        'inverse-primary': '#f2c25c',
        secondary: '#6b655c',
        'on-secondary': '#ffffff',
        'secondary-container': '#eeece7',
        'on-secondary-container': '#514c44',
        tertiary: '#847d72',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#9a948a',
        error: '#dc2626',
        'on-error': '#ffffff',
        'error-container': '#fee2e2',
        'on-error-container': '#991b1b',
        success: '#16a34a',
        'success-container': '#e7f7ee',
        'on-success-container': '#15803d',
        // The logo's bright mark gold — fills, gradients, dark-surface accents.
        // Not for text on light backgrounds (see the note above).
        'brand-gold': '#f5a623',
        // Accent palette for interesting-moment tiles & theme chips.
        'accent-gold': '#9c6209',
        'accent-green': '#16a34a',
        'accent-purple': '#7c3aed',
        'accent-orange': '#ea7317',
        'accent-teal': '#0d9488',
        'accent-amber': '#d97706',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        'label-caps': ['11px', { lineHeight: '1', letterSpacing: '0.05em', fontWeight: '700' }],
        metadata: ['13px', { lineHeight: '1.4', letterSpacing: '0.01em', fontWeight: '500' }],
        'body-md': ['15px', { lineHeight: '1.6', letterSpacing: '0' }],
        'body-lg': ['17px', { lineHeight: '1.6', letterSpacing: '0' }],
        'headline-mobile': ['20px', { lineHeight: '1.3', letterSpacing: '-0.01em', fontWeight: '600' }],
        'display-sm': ['22px', { lineHeight: '1.3', letterSpacing: '-0.01em', fontWeight: '600' }],
        'display-lg': ['30px', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '700' }],
      },
      spacing: {
        base: '4px',
        xs: '8px',
        sm: '16px',
        md: '24px',
        lg: '32px',
        xl: '48px',
        gutter: '24px',
      },
      maxWidth: {
        container: '1200px',
        reading: '820px',
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        sm: '0.375rem',
        lg: '0.625rem',
        xl: '0.875rem',
        '2xl': '1rem',
        full: '9999px',
      },
      boxShadow: {
        // Warm-neutral shadow ink, so cards settle onto the warm canvas instead
        // of casting the old cool-navy tint over it.
        card: '0 1px 2px 0 rgba(38,30,16,0.05), 0 1px 3px 0 rgba(38,30,16,0.04)',
        'card-hover': '0 6px 16px -4px rgba(38,30,16,0.09), 0 2px 6px -2px rgba(38,30,16,0.06)',
        player: '0 8px 30px rgba(38,30,16,0.13)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.3s cubic-bezier(0.23, 1, 0.32, 1) both',
      },
    },
  },
  plugins: [],
}
