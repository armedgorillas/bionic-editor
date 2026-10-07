/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
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
