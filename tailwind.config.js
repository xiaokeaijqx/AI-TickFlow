/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        tick: {
          bg: '#ffffff',
          surface: '#fafafd',
          'surface-strong': '#eaeaed',
          text: '#20242c',
          'text-dim': '#5f6876',
          muted: '#8b93a1',
          accent: '#0d9488',
          'accent-strong': '#0f766e',
          action: '#f97316',
          'action-strong': '#ea580c',
          done: '#94a3b8',
          running: '#b7791f',
          failed: '#dc2626',
        },
      },
      borderRadius: {
        tick: '14px',
      },
    },
  },
  plugins: [],
};
