/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#eef2ff',
          100: '#e0e7ff',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          900: '#312e81',
        },
        surface: {
          DEFAULT: '#0a0a0f',
          50:  '#13131a',
          100: '#1a1a2e',
          200: '#22223b',
          300: '#2d2d44',
        },
        accent: {
          cyan:   '#06b6d4',
          purple: '#a855f7',
          amber:  '#f59e0b',
          green:  '#10b981',
          red:    '#ef4444',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-slow':    'pulse 3s ease-in-out infinite',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'fade-in':       'fadeIn 0.4s ease-out',
        'glow':          'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        slideInRight: {
          '0%':   { transform: 'translateX(20px)', opacity: '0' },
          '100%': { transform: 'translateX(0)',    opacity: '1' },
        },
        fadeIn: {
          '0%':   { opacity: '0' },
          '100%': { opacity: '1' },
        },
        glow: {
          '0%':   { boxShadow: '0 0 5px rgba(99,102,241,0.3)' },
          '100%': { boxShadow: '0 0 20px rgba(99,102,241,0.7)' },
        },
      },
      backdropBlur: { xs: '2px' },
    },
  },
  plugins: [],
};
