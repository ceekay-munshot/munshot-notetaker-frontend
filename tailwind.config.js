/** @type {import('tailwindcss').Config} */
// Munshot Podcasts design tokens — clean, minimal, editorial SaaS.
// Near-white canvas, white cards with subtle borders + faint shadows, a single
// bright blue accent, Inter type scale. Token NAMES are kept stable so the whole
// app re-skins from this one file.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#fafbfc',
        'on-background': '#0f172a',
        surface: '#ffffff',
        'surface-dim': '#eef0f3',
        'surface-bright': '#ffffff',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f6f7f9',
        'surface-container': '#f0f2f5',
        'surface-container-high': '#e9ebef',
        'surface-container-highest': '#e3e6ea',
        'surface-variant': '#f0f2f5',
        'on-surface': '#0f172a',
        // Body / reading text — darkened from slate-600 to slate-700 for a
        // stronger, lower-effort read while staying clearly below headings.
        'on-surface-variant': '#374151',
        'inverse-surface': '#111827',
        'inverse-on-surface': '#f8fafc',
        outline: '#94a3b8',
        'outline-variant': '#e7e9ee',
        'surface-tint': '#2563eb',
        primary: '#2563eb',
        'on-primary': '#ffffff',
        'primary-container': '#1d4ed8',
        'on-primary-container': '#1e40af',
        'primary-fixed': '#dbeafe',
        'primary-fixed-dim': '#bfdbfe',
        'inverse-primary': '#bfdbfe',
        secondary: '#64748b',
        'on-secondary': '#ffffff',
        'secondary-container': '#eef0f3',
        'on-secondary-container': '#475569',
        tertiary: '#7c8089',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#94a3b8',
        error: '#dc2626',
        'on-error': '#ffffff',
        'error-container': '#fee2e2',
        'on-error-container': '#991b1b',
        success: '#16a34a',
        'success-container': '#e7f7ee',
        'on-success-container': '#15803d',
        // Accent palette for interesting-moment tiles & theme chips.
        'accent-blue': '#2563eb',
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
        card: '0 1px 2px 0 rgba(16,24,40,0.04), 0 1px 3px 0 rgba(16,24,40,0.04)',
        'card-hover': '0 6px 16px -4px rgba(16,24,40,0.08), 0 2px 6px -2px rgba(16,24,40,0.05)',
        player: '0 8px 30px rgba(16,24,40,0.12)',
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
