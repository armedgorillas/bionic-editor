/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: 'rgb(var(--bg-surface) / <alpha-value>)',
        panel: 'rgb(var(--bg-panel) / <alpha-value>)',
        elevated: 'rgb(var(--bg-elevated) / <alpha-value>)',
        edge: 'rgb(var(--border-edge) / <alpha-value>)',
        ink: 'rgb(var(--text-ink) / <alpha-value>)',
        muted: 'rgb(var(--text-muted) / <alpha-value>)',
        accent: 'rgb(var(--color-accent) / <alpha-value>)',
        editor: {
          bg: '#fcfcfc',
          sidebar: '#f7f7f8',
          text: '#2d3748',
          accent: '#c0392b',
          muted: '#718096',
          border: '#e2e8f0',
          darkBg: '#1e1e1e',
          darkSidebar: '#252526'
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['"SF Mono"', 'Menlo', 'Monaco', 'Consolas', '"Liberation Mono"', '"Courier New"', 'monospace']
      }
    },
  },
  plugins: [],
}
